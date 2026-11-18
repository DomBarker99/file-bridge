// file-bridge: a small HTTP file server for agent sandboxes.
//
// An agent sandbox on the cluster cannot mount a volume and can only make HTTP
// requests, so this server puts one folder behind five plain HTTP calls:
//
//   GET  /list?path=<folder>        folder listing as JSON ("" or no path = the top)
//   GET  /files/<path>              download a file (HEAD gives its size)
//   PUT  /files/<path>              upload a file; parent folders are created
//                                   add ?overwrite=true to replace an existing file
//   POST /mkdir   {"path": "..."}   create a folder
//   POST /move    {"from": "...", "to": "..."}   move or rename
//   GET  /healthz                   "ok"
//
//   GET  /stat?path=<path>          is it a file or a folder, its size and when it changed
//   GET  /find?q=<text>             files and folders whose path contains every word in q
//
// For people there is a web page (the ui/ folder) that uses the same calls, plus:
//
//   GET  /                          the page
//   GET  /assets/<file>             its script, styles and the two libraries it uses
//   GET  /view/<path>               a picture, PDF, sound or video with its real type, so a
//                                   browser shows it. Every other kind of file is refused here.
//   GET  /usage                     how full the folder's disk is, as JSON
//
// There is no delete and no authentication. Every path is relative to the
// folder in BRIDGE_ROOT and cannot leave it.
//
// Run:   BRIDGE_ROOT=/some/folder PORT=8080 node server.ts
// Test:  node --test server.test.ts
//
// Node runs this file directly (type stripping): no build step, no dependencies.

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, stat, statfs, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export type BridgeOptions = {
  /** The folder that is served. Must exist. */
  root: string;
  /** Largest upload accepted, in bytes. Default 1 GiB. */
  maxUploadBytes?: number;
  /** Where the one-line request log goes. Default: stdout. */
  log?: (line: string) => void;
};

/** Uploads are written here first, then renamed into place, so a half-sent file is never visible. */
const TMP_DIR = ".bridge-tmp";
/** A freshly formatted volume has this folder at its top. It is not anyone's file, so it is not listed. */
const FILESYSTEM_FOLDER = "lost+found";
const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * The page for people: every file in ui/ and ui/vendor/ beside this file, read
 * once at start and served from memory, so a request never touches the disk.
 */
const UI_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const UI_FILES = new Map<string, { body: Buffer; type: string }>();
for (const folder of ["", "vendor/"]) {
  const dir = new URL(`./ui/${folder}`, import.meta.url);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const type = UI_TYPES[extname(entry.name)];
    if (entry.isFile() && type !== undefined) {
      UI_FILES.set(folder + entry.name, { body: readFileSync(new URL(entry.name, dir)), type });
    }
  }
}
/**
 * The page may only load its own files and talk to this server. No inline script
 * runs, so text that came from an agent cannot become code even if it slipped
 * through the page's own escaping.
 */
const UI_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; " +
  "frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Kinds of file that /view sends with their real type. Only kinds a browser
 * shows without running anything from them: no HTML and no SVG.
 */
const VIEW_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
};
/** /find stops looking after this many files and folders, so one search cannot tie the server up. */
const FIND_SCAN_LIMIT = 50_000;
const MAX_JSON_BYTES = 64 * 1024;

const ENDPOINTS = [
  "GET /list?path=<folder>",
  "GET /stat?path=<path>",
  "GET /find?q=<text>",
  "GET /files/<path>",
  "PUT /files/<path>[?overwrite=true]",
  'POST /mkdir {"path": "..."}',
  'POST /move {"from": "...", "to": "..."}',
];

/** An error that becomes an HTTP response with this status and message. */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Turn a client path into safe segments: no "..", no NUL, no backslash, not the temp folder. */
function splitPath(raw: string): string[] {
  if (raw.includes("\0")) throw new HttpError(400, "path contains a NUL byte");
  if (raw.includes("\\")) throw new HttpError(400, "path contains a backslash; use / between folders");
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new HttpError(400, 'path must not contain ".."');
  if (parts[0] === TMP_DIR) throw new HttpError(400, `${TMP_DIR} is reserved`);
  return parts;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createBridge(options: BridgeOptions): Server {
  // The real path, so the "stays inside the root" check also holds when the root itself is a symlink.
  const root = realpathSync(resolve(options.root));
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const log = options.log ?? ((line: string) => console.log(line));

  /**
   * The absolute path for client segments. Follows symlinks on the part of the
   * path that already exists and refuses anything that ends up outside the root.
   */
  async function inside(parts: string[]): Promise<string> {
    const full = join(root, ...parts);
    let existing = full;
    while (existing !== root && !(await exists(existing))) existing = dirname(existing);
    const real = await realpath(existing).catch(() => {
      throw new HttpError(400, "path goes through a broken link");
    });
    if (real !== root && !real.startsWith(root + sep)) {
      throw new HttpError(400, "path leaves the shared folder");
    }
    if (existing !== full && !(await stat(existing)).isDirectory()) {
      throw new HttpError(400, "part of that path is a file, not a folder");
    }
    return full;
  }

  async function list(url: URL, res: ServerResponse): Promise<void> {
    const parts = splitPath(url.searchParams.get("path") ?? "");
    const dir = await inside(parts);
    if (!(await stat(dir)).isDirectory()) {
      throw new HttpError(400, "that is a file, not a folder; download it with GET /files/<path>");
    }
    const entries = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (parts.length === 0 && (entry.name === TMP_DIR || entry.name === FILESYSTEM_FOLDER)) continue;
      const info = await stat(join(dir, entry.name)).catch(() => null);
      if (info === null) continue; // a broken link
      entries.push({
        name: entry.name,
        type: info.isDirectory() ? "dir" : "file",
        size: info.isDirectory() ? null : info.size,
        modified: info.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { path: parts.join("/"), entries });
  }

  async function describeEntry(url: URL, res: ServerResponse): Promise<void> {
    const parts = splitPath(url.searchParams.get("path") ?? "");
    const info = await stat(await inside(parts));
    sendJson(res, 200, {
      path: parts.join("/"),
      type: info.isDirectory() ? "dir" : "file",
      size: info.isDirectory() ? null : info.size,
      modified: info.mtime.toISOString(),
    });
  }

  /** Every file and folder whose path contains each word of q, whatever the letter case. */
  async function find(url: URL, res: ServerResponse): Promise<void> {
    const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter((word) => word !== "");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
    if (words.length === 0) throw new HttpError(400, "give something to look for: /find?q=<text>");
    const found: { path: string; type: string; size: number | null; modified: string }[] = [];
    const queue: string[][] = [[]];
    let scanned = 0;
    while (queue.length > 0 && scanned < FIND_SCAN_LIMIT) {
      const parts = queue.shift() as string[];
      const entries = await readdir(join(root, ...parts), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (parts.length === 0 && (entry.name === TMP_DIR || entry.name === FILESYSTEM_FOLDER)) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue; // links are not followed
        scanned++;
        const path = [...parts, entry.name];
        if (entry.isDirectory()) queue.push(path);
        const joined = path.join("/");
        if (!words.every((word) => joined.toLowerCase().includes(word))) continue;
        const info = await stat(join(root, ...path)).catch(() => null);
        if (info === null) continue;
        found.push({
          path: joined,
          type: entry.isDirectory() ? "dir" : "file",
          size: entry.isDirectory() ? null : info.size,
          modified: info.mtime.toISOString(),
        });
      }
    }
    // Names that match come before paths that only match through a folder; shorter paths first.
    const inName = (path: string) => words.every((word) => (path.split("/").pop() as string).toLowerCase().includes(word));
    found.sort((a, b) => Number(inName(b.path)) - Number(inName(a.path)) || a.path.length - b.path.length || a.path.localeCompare(b.path));
    sendJson(res, 200, {
      query: words.join(" "),
      results: found.slice(0, limit),
      more: found.length > limit || queue.length > 0,
    });
  }

  /** Send a file, or the part of it a Range header asks for (what a video player does to skip ahead). */
  async function sendFile(file: string, info: Stats, type: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | number> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "last-modified": info.mtime.toUTCString(),
    };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range !== null && (range[1] !== "" || range[2] !== "") && info.size > 0) {
      if (range[1] === "") start = Math.max(info.size - Number(range[2]), 0);
      else {
        start = Number(range[1]);
        if (range[2] !== "") end = Math.min(Number(range[2]), info.size - 1);
      }
      if (start > end || start >= info.size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}`, "content-length": 0 }).end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["content-length"] = info.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || info.size === 0) {
      res.end();
      return;
    }
    await pipeline(createReadStream(file, { start, end }), res);
  }

  async function download(parts: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (parts.length === 0) throw new HttpError(400, "give a file path: /files/<path>");
    const file = await inside(parts);
    const info = await stat(file);
    if (info.isDirectory()) {
      throw new HttpError(400, "that is a folder; list it with GET /list?path=<folder>");
    }
    // Always plain bytes, never a type a browser would run: files here come from agents.
    await sendFile(file, info, "application/octet-stream", req, res);
  }

  async function view(parts: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (parts.length === 0) throw new HttpError(400, "give a file path: /view/<path>");
    const type = VIEW_TYPES[extname(parts[parts.length - 1]).toLowerCase()];
    if (type === undefined) {
      throw new HttpError(415, "this kind of file is not shown in a browser; download it with GET /files/<path>");
    }
    const file = await inside(parts);
    const info = await stat(file);
    if (info.isDirectory()) throw new HttpError(400, "that is a folder");
    await sendFile(file, info, type, req, res);
  }

  async function usage(res: ServerResponse): Promise<void> {
    const disk = await statfs(root);
    const totalBytes = disk.blocks * disk.bsize;
    sendJson(res, 200, {
      totalBytes,
      usedBytes: totalBytes - disk.bfree * disk.bsize,
      freeBytes: disk.bavail * disk.bsize,
    });
  }

  async function upload(parts: string[], url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (parts.length === 0) throw new HttpError(400, "give a file path: /files/<path>");
    const target = await inside(parts);
    const before = await stat(target).catch(() => null);
    if (before?.isDirectory()) throw new HttpError(409, "a folder already has that name");
    if (before !== null && url.searchParams.get("overwrite") !== "true") {
      throw new HttpError(409, "that file already exists; add ?overwrite=true to replace it");
    }
    const tooLarge = new HttpError(413, `upload is larger than the ${maxUploadBytes} byte limit`);
    if (Number(req.headers["content-length"] ?? 0) > maxUploadBytes) throw tooLarge;

    await mkdir(join(root, TMP_DIR), { recursive: true });
    const tmp = join(root, TMP_DIR, randomUUID());
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > maxUploadBytes) done(tooLarge);
        else done(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmp, { flags: "wx" }));
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {}); // only the server's own partial upload
      throw error;
    }
    sendJson(res, before === null ? 201 : 200, { path: parts.join("/"), size, replaced: before !== null });
  }

  async function makeFolder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parts = splitPath(text(body, "path"));
    if (parts.length === 0) throw new HttpError(400, '"path" is empty');
    const dir = await inside(parts);
    const before = await stat(dir).catch(() => null);
    if (before !== null && !before.isDirectory()) throw new HttpError(409, "a file already has that name");
    await mkdir(dir, { recursive: true });
    sendJson(res, before === null ? 201 : 200, { path: parts.join("/"), created: before === null });
  }

  async function move(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const fromParts = splitPath(text(body, "from"));
    const toParts = splitPath(text(body, "to"));
    if (fromParts.length === 0 || toParts.length === 0) throw new HttpError(400, '"from" and "to" must not be empty');
    const from = await inside(fromParts);
    const to = await inside(toParts);
    if (!(await exists(from))) throw new HttpError(404, `"from" does not exist: ${fromParts.join("/")}`);
    if (await exists(to)) throw new HttpError(409, `"to" already exists: ${toParts.join("/")}`);
    if (to.startsWith(from + sep)) throw new HttpError(400, "cannot move a folder into itself");
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    sendJson(res, 200, { from: fromParts.join("/"), to: toParts.join("/") });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://file-bridge");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (path === "/healthz") {
      allow(method, ["GET", "HEAD"]);
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else if (path === "/favicon.ico") {
      // Browsers ask for this by themselves. There is no picture; say so quietly.
      allow(method, ["GET", "HEAD"]);
      res.writeHead(204).end();
    } else if (path === "/" || path.startsWith("/assets/")) {
      allow(method, ["GET", "HEAD"]);
      const asset = UI_FILES.get(path === "/" ? "index.html" : path.slice("/assets/".length));
      if (asset === undefined) throw new HttpError(404, `unknown address ${path}`);
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": asset.body.length,
        "content-security-policy": UI_POLICY,
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      });
      res.end(method === "HEAD" ? undefined : asset.body);
    } else if (path === "/usage") {
      allow(method, ["GET"]);
      await usage(res);
    } else if (path === "/list") {
      allow(method, ["GET"]);
      await list(url, res);
    } else if (path === "/stat") {
      allow(method, ["GET"]);
      await describeEntry(url, res);
    } else if (path === "/find") {
      allow(method, ["GET"]);
      await find(url, res);
    } else if (path === "/files" || path.startsWith("/files/") || path === "/view" || path.startsWith("/view/")) {
      const viewing = path.startsWith("/view");
      allow(method, viewing ? ["GET", "HEAD"] : ["GET", "HEAD", "PUT"]);
      let decoded: string;
      try {
        decoded = decodeURIComponent(path.slice(viewing ? "/view".length : "/files".length));
      } catch {
        throw new HttpError(400, "path is not valid percent-encoding");
      }
      const parts = splitPath(decoded);
      if (viewing) await view(parts, req, res);
      else if (method === "PUT") await upload(parts, url, req, res);
      else await download(parts, req, res);
    } else if (path === "/mkdir") {
      allow(method, ["POST"]);
      await makeFolder(req, res);
    } else if (path === "/move") {
      allow(method, ["POST"]);
      await move(req, res);
    } else {
      throw new HttpError(404, `unknown address ${path}`);
    }
  }

  return createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((error: unknown) => {
      const [status, message] = describe(error);
      if (status === 500) log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (res.headersSent) {
        res.destroy(); // the reply already started (a download); all that is left is to cut it short
        return;
      }
      // A request body that was refused part-way is not read to the end; close the connection instead.
      const unread = !req.complete;
      const extra: Record<string, string> = unread ? { connection: "close" } : {};
      if (error instanceof MethodError) extra.allow = error.allowed.join(", ");
      sendJson(res, status, status === 404 || status === 405 ? { error: message, endpoints: ENDPOINTS } : { error: message }, extra);
      if (unread) res.on("finish", () => req.destroy());
    });
  });
}

class MethodError extends HttpError {
  allowed: string[];
  constructor(method: string, allowed: string[]) {
    super(405, method === "DELETE" ? "delete is not offered by this server" : `${method} is not supported here`);
    this.allowed = allowed;
  }
}

function allow(method: string, allowed: string[]): void {
  if (!allowed.includes(method)) throw new MethodError(method, allowed);
}

/** The status and message for an error; file-system errors get a plain explanation. */
function describe(error: unknown): [number, string] {
  if (error instanceof HttpError) return [error.status, error.message];
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return [404, "no such file or folder"];
  if (code === "ENOTDIR") return [400, "part of that path is a file, not a folder"];
  if (code === "EISDIR") return [400, "that is a folder"];
  if (code === "ENOSPC") return [507, "the shared folder is full"];
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET") return [400, "the upload was cut off"];
  return [500, "the file bridge hit an unexpected error"];
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body) + "\n";
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "JSON body is too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON, for example {\"path\": \"reports/2026\"}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `"${key}" must be a string`);
  return value;
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = process.env.BRIDGE_ROOT ?? "/srv/files";
  const port = Number(process.env.PORT ?? 8080);
  const maxUploadBytes = Number(process.env.BRIDGE_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  const server = createBridge({ root, maxUploadBytes });
  server.listen(port, "0.0.0.0", () => {
    console.log(`file-bridge serving ${root} on port ${port} (upload limit ${maxUploadBytes} bytes)`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    });
  }
}
