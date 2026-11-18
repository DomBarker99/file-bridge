// Tests for server.ts. Each test starts the bridge on a free port over a new
// temporary folder and talks to it over real HTTP.
//
//   node --test server.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge } from "./server.ts";

type Bridge = { url: string; root: string; close: () => Promise<void> };

async function start(maxUploadBytes?: number): Promise<Bridge> {
  const root = await mkdtemp(join(tmpdir(), "file-bridge-test-"));
  const server = createBridge({ root, maxUploadBytes, log: () => {} });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    root,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("upload, list and download a binary file", async () => {
  const bridge = await start();
  try {
    const bytes = randomBytes(3 * 1024 * 1024);
    const put = await fetch(`${bridge.url}/files/reports/2026/chart.bin`, { method: "PUT", body: bytes });
    assert.equal(put.status, 201);
    assert.deepEqual(await put.json(), { path: "reports/2026/chart.bin", size: bytes.length, replaced: false });

    const top = await (await fetch(`${bridge.url}/list`)).json();
    assert.deepEqual(
      top.entries.map((entry: { name: string; type: string }) => [entry.name, entry.type]),
      [["reports", "dir"]], // the temp folder is hidden
    );
    const folder = await (await fetch(`${bridge.url}/list?path=reports/2026`)).json();
    assert.equal(folder.path, "reports/2026");
    assert.equal(folder.entries[0].name, "chart.bin");
    assert.equal(folder.entries[0].size, bytes.length);

    const head = await fetch(`${bridge.url}/files/reports/2026/chart.bin`, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    const got = Buffer.from(await (await fetch(`${bridge.url}/files/reports/2026/chart.bin`)).arrayBuffer());
    assert.ok(got.equals(bytes));

    // Nothing is left behind in the temp folder after a finished upload.
    assert.deepEqual(await readdir(join(bridge.root, ".bridge-tmp")), []);
  } finally {
    await bridge.close();
  }
});

test("names with spaces and non-ASCII characters survive", async () => {
  const bridge = await start();
  try {
    const name = "my notes/résumé final.txt";
    const put = await fetch(`${bridge.url}/files/${encodeURI(name)}`, { method: "PUT", body: "hello" });
    assert.equal(put.status, 201);
    assert.equal(await readFile(join(bridge.root, name), "utf8"), "hello");
    const listing = await (await fetch(`${bridge.url}/list?path=${encodeURIComponent("my notes")}`)).json();
    assert.equal(listing.entries[0].name, "résumé final.txt");
  } finally {
    await bridge.close();
  }
});

test("an existing file is only replaced with ?overwrite=true", async () => {
  const bridge = await start();
  try {
    await fetch(`${bridge.url}/files/a.txt`, { method: "PUT", body: "one" });
    const refused = await fetch(`${bridge.url}/files/a.txt`, { method: "PUT", body: "two" });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /overwrite=true/);
    assert.equal(await readFile(join(bridge.root, "a.txt"), "utf8"), "one");

    const replaced = await fetch(`${bridge.url}/files/a.txt?overwrite=true`, { method: "PUT", body: "two" });
    assert.equal(replaced.status, 200);
    assert.equal((await replaced.json()).replaced, true);
    assert.equal(await readFile(join(bridge.root, "a.txt"), "utf8"), "two");
  } finally {
    await bridge.close();
  }
});

test("mkdir and move", async () => {
  const bridge = await start();
  try {
    const made = await post(`${bridge.url}/mkdir`, { path: "drafts/old" });
    assert.equal(made.status, 201);
    assert.equal((await post(`${bridge.url}/mkdir`, { path: "drafts/old" })).status, 200);

    await fetch(`${bridge.url}/files/drafts/note.txt`, { method: "PUT", body: "x" });
    const moved = await post(`${bridge.url}/move`, { from: "drafts/note.txt", to: "final/2026/note.txt" });
    assert.equal(moved.status, 200);
    assert.equal(await readFile(join(bridge.root, "final/2026/note.txt"), "utf8"), "x");

    await fetch(`${bridge.url}/files/other.txt`, { method: "PUT", body: "y" });
    const clash = await post(`${bridge.url}/move`, { from: "other.txt", to: "final/2026/note.txt" });
    assert.equal(clash.status, 409);
    assert.equal((await post(`${bridge.url}/move`, { from: "nope.txt", to: "z.txt" })).status, 404);
    assert.equal((await post(`${bridge.url}/move`, { from: "drafts", to: "drafts/old/inner" })).status, 400);
    assert.equal((await post(`${bridge.url}/mkdir`, { path: "other.txt" })).status, 409);
    assert.equal((await post(`${bridge.url}/mkdir`, { nope: 1 })).status, 400);
  } finally {
    await bridge.close();
  }
});

test("paths cannot leave the shared folder", async () => {
  const bridge = await start();
  try {
    const outside = await mkdtemp(join(tmpdir(), "file-bridge-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(bridge.root, "link"));
    await mkdir(join(bridge.root, "real"));

    assert.equal((await fetch(`${bridge.url}/list?path=../`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/list?path=real/../..`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/files/..%2Fsecret.txt`)).status, 400);
    assert.equal((await post(`${bridge.url}/move`, { from: "real", to: "../moved" })).status, 400);
    assert.equal((await post(`${bridge.url}/mkdir`, { path: "a\\b" })).status, 400);

    // A link that points outside is refused for reading, listing and writing.
    assert.equal((await fetch(`${bridge.url}/files/link/secret.txt`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/list?path=link`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/files/link/new.txt`, { method: "PUT", body: "x" })).status, 400);
    assert.deepEqual(await readdir(outside), ["secret.txt"]);

    // The temp folder is not reachable by name.
    assert.equal((await fetch(`${bridge.url}/list?path=.bridge-tmp`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/files/.bridge-tmp/x`, { method: "PUT", body: "x" })).status, 400);
  } finally {
    await bridge.close();
  }
});

test("an upload over the limit is refused and leaves nothing behind", async () => {
  const bridge = await start(1000);
  try {
    const refused = await fetch(`${bridge.url}/files/big.bin`, { method: "PUT", body: randomBytes(5000) });
    assert.equal(refused.status, 413);
    assert.deepEqual(await readdir(bridge.root).then((names) => names.filter((name) => name !== ".bridge-tmp")), []);
    assert.equal((await fetch(`${bridge.url}/files/ok.bin`, { method: "PUT", body: randomBytes(1000) })).status, 201);
  } finally {
    await bridge.close();
  }
});

test("the page for people, the usage numbers, and what is kept out of sight", async () => {
  const bridge = await start();
  try {
    const page = await fetch(`${bridge.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await page.text(), /<title>file bridge<\/title>/);
    assert.equal((await fetch(`${bridge.url}/`, { method: "POST" })).status, 405);

    const usage = await (await fetch(`${bridge.url}/usage`)).json();
    assert.ok(usage.totalBytes > 0 && usage.freeBytes > 0);
    assert.ok(usage.usedBytes >= 0 && usage.usedBytes <= usage.totalBytes);

    // The folder a new volume starts with is hidden at the top, and only there.
    await mkdir(join(bridge.root, "lost+found"));
    await mkdir(join(bridge.root, "kept/lost+found"), { recursive: true });
    const names = async (path: string) =>
      (await (await fetch(`${bridge.url}/list?path=${encodeURIComponent(path)}`)).json()).entries.map((entry: { name: string }) => entry.name);
    assert.deepEqual(await names(""), ["kept"]);
    assert.deepEqual(await names("kept"), ["lost+found"]);

    // A file is always sent as plain bytes, whatever its name says.
    await fetch(`${bridge.url}/files/page.html`, { method: "PUT", body: "<script>alert(1)</script>" });
    const file = await fetch(`${bridge.url}/files/page.html`);
    assert.equal(file.headers.get("content-type"), "application/octet-stream");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await bridge.close();
  }
});

test("wrong addresses and methods explain themselves", async () => {
  const bridge = await start();
  try {
    await fetch(`${bridge.url}/files/a.txt`, { method: "PUT", body: "one" });
    await mkdir(join(bridge.root, "folder"));

    const deleted = await fetch(`${bridge.url}/files/a.txt`, { method: "DELETE" });
    assert.equal(deleted.status, 405);
    assert.equal(deleted.headers.get("allow"), "GET, HEAD, PUT");
    assert.match((await deleted.json()).error, /delete is not offered/);

    const unknown = await fetch(`${bridge.url}/nope`);
    assert.equal(unknown.status, 404);
    assert.ok(Array.isArray((await unknown.json()).endpoints));

    assert.equal((await fetch(`${bridge.url}/files/missing.txt`)).status, 404);
    assert.equal((await fetch(`${bridge.url}/list?path=missing`)).status, 404);
    assert.equal((await fetch(`${bridge.url}/files/folder`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/list?path=a.txt`)).status, 400);
    assert.equal((await fetch(`${bridge.url}/files/a.txt/b.txt`, { method: "PUT", body: "x" })).status, 400);
    assert.equal((await fetch(`${bridge.url}/files/folder`, { method: "PUT", body: "x" })).status, 409);
    assert.equal((await fetch(`${bridge.url}/mkdir`, { method: "POST", body: "not json" })).status, 400);
    assert.equal(await (await fetch(`${bridge.url}/healthz`)).text(), "ok\n");
  } finally {
    await bridge.close();
  }
});
