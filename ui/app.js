"use strict";

/*
 * The file bridge page: a folder tree at the side, and on the right either a
 * folder's contents or one file, shown the way its kind allows.
 *
 * Where you are is the part of the address after "#/", so every folder and file
 * has a link. Everything is done with the server's own calls: /list, /stat,
 * /find, /files, /view, /mkdir, /move and /usage.
 *
 * Text that comes from files is always put on the page as text, never as HTML,
 * with two exceptions that produce their own safe HTML: the code colouring
 * (highlight.js escapes what it is given) and Markdown (markdown-it with raw
 * HTML switched off). The server also forbids inline script on this page.
 */

const $ = (id) => document.getElementById(id);

const ICON = {
  dir: '<svg class="ico-dir" width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.1c.4 0 .8.2 1.1.5l1 1.3H13a1.5 1.5 0 0 1 1.5 1.5v6.7a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12Z"/></svg>',
  file: '<svg class="ico-file" width="16" height="16" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M3.7 1.7h5.5l3.1 3.1v9.5H3.7ZM9 1.9V5h3.1"/></svg>',
  twist: '<svg width="12" height="12" viewBox="0 0 12 12"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5 8 6 4.5 9.5"/></svg>',
  menu: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 3h13v1.6h-13Zm0 4.2h13v1.6h-13Zm0 4.2h13V13h-13Z"/></svg>',
};

/* Kinds the server will send with their real type, through /view. */
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];
const VIDEO = ["mp4", "m4v", "webm", "mov"];
const AUDIO = ["mp3", "m4a", "wav", "ogg", "flac"];

/* File ending -> the name highlight.js knows the language by. */
const LANGUAGE = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript",
  py: "python", sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", md: "markdown",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", go: "go", rs: "rust", java: "java",
  kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", sql: "sql", swift: "swift",
  lua: "lua", r: "r", pl: "perl", ini: "ini", toml: "ini", conf: "ini", cfg: "ini", diff: "diff", patch: "diff", graphql: "graphql", gql: "graphql",
};

const MAX_TEXT = 2 * 1024 * 1024;   // larger text files are offered as a download
const MAX_COLOUR = 400 * 1024;      // larger ones are shown without colouring
const MAX_ROWS = 2000;              // rows of a CSV shown as a table

let here = { parts: [], type: "dir" };  // what is on screen
let turn = 0;                           // counts navigations, so a slow answer for an old one is dropped
const tree = new Map();                 // folder path -> { open, kids }

/* ---------- small helpers ---------- */

const enc = (parts) => parts.map(encodeURIComponent).join("/");
const hashFor = (parts) => "#/" + enc(parts);
const ext = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const dirsFirst = (a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1);

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

/** One of the drawings above. They are fixed text written in this file, nothing from a file or a name. */
function icon(name) {
  const span = el("span", { className: "i" });
  span.innerHTML = ICON[name];
  return span.firstChild;
}

function size(bytes) {
  if (bytes === null || bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + units[i];
}

function ago(iso) {
  const then = new Date(iso);
  const s = (Date.now() - then.getTime()) / 1000;
  const say = (n, unit) => n + " " + unit + (n === 1 ? "" : "s") + " ago";
  if (s < 60) return "just now";
  if (s < 3600) return say(Math.floor(s / 60), "minute");
  if (s < 86400) return say(Math.floor(s / 3600), "hour");
  if (s < 86400 * 30) return say(Math.floor(s / 86400), "day");
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function changed(iso) {
  return el("span", { textContent: ago(iso), title: new Date(iso).toLocaleString() });
}

let toastTimer = 0;
function toast(text, kind) {
  clearTimeout(toastTimer);
  const box = $("toast");
  box.textContent = text;
  box.className = "toast" + (kind ? " " + kind : "");
  box.hidden = text === "";
  if (text !== "" && kind !== "bad") toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error((body && body.error) || ("HTTP " + res.status)), { status: res.status });
  return body;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};

/* ---------- light and dark ---------- */

const THEMES = ["auto", "light", "dark"];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const mode = THEMES.includes(store.get("fb-theme")) ? store.get("fb-theme") : "auto";
  const dark = mode === "dark" || (mode === "auto" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("hlLight").disabled = dark;
  $("hlDark").disabled = !dark;
  $("theme").textContent = "Theme: " + mode;
}

/* ---------- where we are ---------- */

function readHash() {
  let raw = location.hash.replace(/^#\/?/, "");
  try { raw = decodeURIComponent(raw); } catch { /* keep it as typed */ }
  return raw.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
}

function targetFolder() {
  return here.type === "dir" ? here.parts : here.parts.slice(0, -1);
}

function drawCrumbs(parts, isFile) {
  const box = $("crumbs");
  box.replaceChildren(parts.length === 0 ? el("b", { textContent: "Home" }) : el("a", { href: "#/", textContent: "Home" }));
  parts.forEach((part, i) => {
    box.append(el("span", { textContent: "/" }));
    const last = i === parts.length - 1;
    box.append(last ? el("b", { textContent: part }) : el("a", { href: hashFor(parts.slice(0, i + 1)), textContent: part }));
  });
  document.title = (parts.length ? parts[parts.length - 1] + " · " : "") + "file bridge";
  $("newFolder").hidden = isFile;
}

async function show() {
  const mine = ++turn;
  const parts = readHash();
  closeFind();
  let info = { type: "dir" };
  if (parts.length > 0) {
    try { info = await api("/stat?path=" + encodeURIComponent(parts.join("/"))); }
    catch (error) { if (mine === turn) showMissing(parts, error); return; }
  }
  if (mine !== turn) return;
  here = { parts, type: info.type };
  drawCrumbs(parts, info.type === "file");
  $("missing").hidden = true;
  $("folder").hidden = info.type !== "dir";
  $("file").hidden = info.type !== "file";
  if (info.type === "dir") await showFolder(parts, mine);
  else await showFile(parts, info, mine);
  if (mine !== turn) return;
  await syncTree();
  usage();
}

function showMissing(parts, error) {
  here = { parts: parts.slice(0, -1), type: "dir" };
  drawCrumbs(parts, false);
  $("folder").hidden = true;
  $("file").hidden = true;
  $("missing").hidden = false;
  $("missing").textContent = error.status === 404
    ? "There is nothing at " + parts.join("/") + ". It may have been moved or renamed."
    : "Could not open " + parts.join("/") + ": " + error.message;
}

async function usage() {
  try {
    const u = await api("/usage");
    $("usageText").textContent = size(u.usedBytes) + " of " + size(u.totalBytes);
    $("usageBar").style.width = Math.max(1, Math.min(100, (u.usedBytes / u.totalBytes) * 100)) + "%";
  } catch { $("usageText").textContent = ""; }
}

/* ---------- the folder tree ---------- */

async function loadKids(path) {
  const listing = await api("/list?path=" + encodeURIComponent(path));
  const node = tree.get(path) || { open: path === "", kids: null };
  node.kids = listing.entries.slice().sort(dirsFirst);
  tree.set(path, node);
  return node;
}

function drawLevel(path) {
  const node = tree.get(path);
  const list = el("ul");
  if (!node || !node.kids) return list;
  if (node.kids.length === 0 && path !== "") list.append(el("li", { className: "none", textContent: "empty" }));
  const base = path === "" ? [] : path.split("/");
  const current = here.parts.join("/");
  for (const kid of node.kids) {
    const parts = base.concat(kid.name);
    const kidPath = parts.join("/");
    const isDir = kid.type === "dir";
    const open = isDir && tree.get(kidPath) && tree.get(kidPath).open;
    const twist = el("span", { className: "twist" });
    if (isDir) {
      twist.append(icon("twist"));
      twist.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggle(kidPath); });
    }
    const row = el("a", { className: "node" + (open ? " open" : "") + (kidPath === current ? " on" : ""), href: hashFor(parts), title: kidPath },
      twist, icon(isDir ? "dir" : "file"), el("span", { className: "name", textContent: kid.name }));
    const item = el("li", null, row);
    if (open) item.append(drawLevel(kidPath));
    list.append(item);
  }
  return list;
}

function drawTree() {
  $("tree").replaceChildren(drawLevel(""));
  const on = $("tree").querySelector(".node.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

async function toggle(path) {
  const node = tree.get(path) || { open: false, kids: null };
  node.open = !node.open;
  tree.set(path, node);
  if (node.open && !node.kids) { try { await loadKids(path); } catch { node.open = false; } }
  drawTree();
}

/** Open every folder on the way to where we are, so the tree shows it. */
async function syncTree() {
  const folders = here.type === "dir" ? here.parts : here.parts.slice(0, -1);
  const wanted = [""].concat(folders.map((_, i) => folders.slice(0, i + 1).join("/")));
  for (const path of wanted) {
    const node = tree.get(path) || { open: true, kids: null };
    node.open = true;
    tree.set(path, node);
    if (!node.kids) { try { await loadKids(path); } catch { /* it is gone; the main area says so */ } }
  }
  drawTree();
}

/** After something changed: read again every folder the tree has open. */
async function refresh() {
  await Promise.all([...tree.keys()].filter((path) => tree.get(path).kids).map((path) => loadKids(path).catch(() => tree.delete(path))));
  await show();
}

/* ---------- a folder ---------- */

async function showFolder(parts, mine) {
  let listing;
  try { listing = await api("/list?path=" + encodeURIComponent(parts.join("/"))); }
  catch (error) { if (mine === turn) showMissing(parts, error); return; }
  if (mine !== turn) return;
  const rows = [];
  if (parts.length > 0) {
    rows.push(el("tr", null, el("td", { className: "name", colSpan: 4 }, el("a", { href: hashFor(parts.slice(0, -1)), title: "Up one folder" }, icon("dir"), ".."))));
  }
  for (const entry of listing.entries.slice().sort(dirsFirst)) {
    const path = parts.concat(entry.name);
    const isDir = entry.type === "dir";
    const actions = el("td", { className: "act" });
    if (!isDir) actions.append(el("a", { className: "btn", href: "/files/" + enc(path), download: entry.name, textContent: "Download" }));
    const move = el("button", { textContent: "Move or rename" });
    move.addEventListener("click", () => moveEntry(path));
    actions.append(move);
    rows.push(el("tr", null,
      el("td", { className: "name" }, el("a", { href: hashFor(path) }, icon(isDir ? "dir" : "file"), entry.name)),
      el("td", { className: "num", textContent: isDir ? "" : size(entry.size) }),
      el("td", { className: "num" }, changed(entry.modified)),
      actions));
  }
  $("rows").replaceChildren(...rows);
  $("empty").hidden = listing.entries.length > 0;
}

/* ---------- one file ---------- */

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function message(text) {
  return el("pre", { className: "plain", textContent: text });
}

/** Text with line numbers, coloured when the language is known and the file is not huge. */
function codeView(text, language) {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const count = body === "" ? 1 : body.split("\n").length;
  const numbers = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  const code = el("code", { className: "hljs" });
  const known = language && window.hljs && window.hljs.getLanguage(language);
  if (known && text.length <= MAX_COLOUR) {
    try { code.innerHTML = window.hljs.highlight(body, { language, ignoreIllegals: true }).value; }
    catch { code.textContent = body; }
  } else {
    code.textContent = body;
  }
  return el("div", { className: "code" }, el("pre", { className: "nums", textContent: numbers }), el("pre", { className: "src" }, code));
}

/** Turn a link or picture address written in a Markdown file into parts from the top of the shared folder. */
function resolveRelative(folder, address) {
  let path = address.split("#")[0].split("?")[0];
  try { path = decodeURIComponent(path); } catch { /* keep it */ }
  const out = path.startsWith("/") ? [] : folder.slice();
  for (const piece of path.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") out.pop(); else out.push(piece);
  }
  return out;
}

function markdownView(text, folder) {
  const box = el("div", { className: "md" });
  if (!window.markdownit) { box.append(message(text)); return box; }
  const md = window.markdownit({
    html: false,     // raw HTML in the file is shown as text, never used
    linkify: true,
    highlight(source, language) {
      if (language && window.hljs && window.hljs.getLanguage(language)) {
        try { return window.hljs.highlight(source, { language, ignoreIllegals: true }).value; } catch { /* fall through */ }
      }
      return "";
    },
  });
  // Column alignment would arrive as a style attribute, which this page does not allow; make it a class.
  for (const rule of ["th_open", "td_open"]) {
    md.renderer.rules[rule] = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const align = /text-align:\s*(right|center)/.exec(token.attrGet("style") || "");
      token.attrs = (token.attrs || []).filter((attr) => attr[0] !== "style");
      if (align) token.attrJoin("class", "ta-" + align[1]);
      return self.renderToken(tokens, index, options);
    };
  }
  // A picture kept beside the file is shown through /view. Any other picture, such as one
  // on another website, is named instead of loaded, so opening a file never calls out.
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const src = token.attrGet("src") || "";
    const alt = self.renderInlineAsText(token.children || [], options, env);
    const parts = /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") ? null : resolveRelative(folder, src);
    if (parts && parts.length && IMAGE.includes(ext(parts[parts.length - 1]))) {
      return '<img src="' + md.utils.escapeHtml("/view/" + enc(parts)) + '" alt="' + md.utils.escapeHtml(alt) + '">';
    }
    return '<span class="gone">[picture not shown: ' + md.utils.escapeHtml(alt || src) + "]</span>";
  };
  box.innerHTML = md.render(text);

  for (const link of box.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (href.startsWith("#")) { link.removeAttribute("href"); continue; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^(https?|mailto):/i.test(href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      else link.removeAttribute("href");
    } else {
      link.setAttribute("href", hashFor(resolveRelative(folder, href)));
    }
  }
  // "- [x] done" and "- [ ] to do" become ticked and empty boxes, as on GitHub.
  for (const item of box.querySelectorAll("li")) {
    const first = item.firstChild && item.firstChild.nodeType === 1 && item.firstChild.tagName === "P" ? item.firstChild.firstChild : item.firstChild;
    const mark = first && first.nodeType === 3 ? /^\[( |x|X)\] /.exec(first.textContent) : null;
    if (!mark) continue;
    first.textContent = first.textContent.slice(4);
    first.before(el("input", { type: "checkbox", disabled: true, checked: mark[1] !== " " }), " ");
    item.classList.add("task");
  }
  return box;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < MAX_ROWS; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if ((cell !== "" || row.length > 0) && rows.length < MAX_ROWS) { row.push(cell); rows.push(row); }
  return rows;
}

function tableView(text, delimiter) {
  const rows = parseDelimited(text, delimiter);
  const table = el("table");
  rows.forEach((row, i) => {
    const tr = el("tr", null, el("td", { className: "n", textContent: i === 0 ? "" : String(i) }));
    for (const cell of row) tr.append(el(i === 0 ? "th" : "td", { textContent: cell }));
    table.append(tr);
  });
  const box = el("div", { className: "sheet" }, table);
  if (rows.length >= MAX_ROWS) box.append(message("Only the first " + MAX_ROWS + " rows are shown."));
  return box;
}

/** The buttons that switch between two ways of showing the same file. */
function setModes(modes, draw) {
  const box = $("modes");
  box.hidden = modes.length < 2;
  const buttons = modes.map((mode) => {
    const button = el("button", { textContent: mode });
    button.addEventListener("click", () => pick(mode));
    return button;
  });
  box.replaceChildren(...buttons);
  function pick(mode) {
    buttons.forEach((button) => button.classList.toggle("on", button.textContent === mode));
    $("fileBody").replaceChildren(draw(mode));
  }
  pick(modes[0]);
}

async function showFile(parts, info, mine) {
  const name = parts[parts.length - 1];
  const kind = ext(name);
  const view = "/view/" + enc(parts);
  const describe = (extra) => { $("fileInfo").replaceChildren((extra ? extra + " · " : "") + size(info.size) + " · changed ", changed(info.modified)); };
  describe("");
  Object.assign($("download"), { href: "/files/" + enc(parts), download: name });
  $("modes").hidden = true;
  const body = $("fileBody");
  body.replaceChildren(message("Loading…"));

  if (IMAGE.includes(kind)) { body.replaceChildren(el("div", { className: "media" }, el("img", { src: view, alt: name }))); return; }
  if (VIDEO.includes(kind)) { body.replaceChildren(el("div", { className: "media" }, el("video", { src: view, controls: true }))); return; }
  if (AUDIO.includes(kind)) { body.replaceChildren(el("div", { className: "media" }, el("audio", { src: view, controls: true }))); return; }
  if (kind === "pdf") { body.replaceChildren(el("iframe", { className: "pdf", src: view, title: name })); return; }
  if (info.size > MAX_TEXT) { body.replaceChildren(message("This file is " + size(info.size) + ", too large to show here. Download it instead.")); return; }

  let bytes;
  try {
    const res = await fetch("/files/" + enc(parts));
    if (!res.ok) throw new Error("HTTP " + res.status);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    if (mine === turn) body.replaceChildren(message("Could not read the file: " + error.message));
    return;
  }
  if (mine !== turn) return;
  if (looksBinary(bytes)) { body.replaceChildren(message("This is not a text file, so there is nothing to show. Download it instead.")); return; }

  let text = new TextDecoder("utf-8").decode(bytes);
  const lines = text === "" ? 0 : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
  describe(lines + (lines === 1 ? " line" : " lines"));
  if (text === "") { body.replaceChildren(message("(empty file)")); return; }

  const language = LANGUAGE[kind] || (/^(makefile|gnumakefile)$/i.test(name) ? "makefile" : "");
  if (kind === "md" || kind === "markdown") {
    setModes(["Preview", "Code"], (mode) => (mode === "Preview" ? markdownView(text, parts.slice(0, -1)) : codeView(text, "markdown")));
  } else if (kind === "csv" || kind === "tsv") {
    setModes(["Table", "Code"], (mode) => (mode === "Table" ? tableView(text, kind === "tsv" ? "\t" : ",") : codeView(text, "")));
  } else {
    // A JSON file written on one line is laid out so it can be read.
    if (kind === "json" && lines <= 2) { try { text = JSON.stringify(JSON.parse(text), null, 2) + "\n"; describe(lines + " line, laid out to read"); } catch { /* not valid JSON; show as is */ } }
    body.replaceChildren(codeView(text, language));
  }
}

/* ---------- go to file ---------- */

let findTimer = 0, findTurn = 0, findOn = -1;

function closeFind() {
  $("findResults").hidden = true;
  findOn = -1;
}

async function runFind() {
  const mine = ++findTurn;
  const q = $("find").value.trim();
  const box = $("findResults");
  if (q === "") { closeFind(); return; }
  let answer;
  try { answer = await api("/find?limit=30&q=" + encodeURIComponent(q)); }
  catch (error) { if (mine === findTurn) { box.replaceChildren(el("div", { className: "none", textContent: "Search failed: " + error.message })); box.hidden = false; } return; }
  if (mine !== findTurn) return;
  findOn = -1;
  const items = answer.results.map((hit) => {
    const parts = hit.path.split("/");
    return el("a", { href: hashFor(parts) }, icon(hit.type === "dir" ? "dir" : "file"),
      el("b", { textContent: parts[parts.length - 1] }), el("span", { textContent: parts.slice(0, -1).join("/") }));
  });
  if (items.length === 0) items.push(el("div", { className: "none", textContent: "Nothing found for " + q }));
  else if (answer.more) items.push(el("div", { className: "none", textContent: "There are more. Type more of the name." }));
  box.replaceChildren(...items);
  box.hidden = false;
}

function moveFind(step) {
  const links = [...$("findResults").querySelectorAll("a")];
  if (links.length === 0) return;
  findOn = (findOn + step + links.length) % links.length;
  links.forEach((link, i) => link.classList.toggle("on", i === findOn));
  links[findOn].scrollIntoView({ block: "nearest" });
}

/* ---------- changing things ---------- */

async function newFolder() {
  const name = prompt("Name of the new folder:");
  if (!name) return;
  try {
    await api("/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: targetFolder().concat(name).join("/") }) });
    toast("Made the folder " + name + ".", "ok");
    await refresh();
  } catch (error) { toast("Could not make the folder: " + error.message, "bad"); }
}

async function moveEntry(path) {
  const from = path.join("/");
  const to = prompt("Move or rename. New path, from the top of the shared folder:", from);
  if (!to || to === from) return;
  try {
    const done = await api("/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to }) });
    toast("Moved " + from + " to " + done.to + ".", "ok");
    // If what moved is what is on screen, follow it.
    if (here.parts.join("/") === from) { tree.clear(); location.hash = hashFor(done.to.split("/")); }
    await refresh();
  } catch (error) { toast("Could not move it: " + error.message, "bad"); }
}

/** One upload, with a percentage. Resolves to the HTTP status and the server's message. */
function put(file, parts, overwrite, label) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/files/" + enc(parts) + (overwrite ? "?overwrite=true" : ""));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) toast(label + " " + Math.round((e.loaded / e.total) * 100) + "%"); };
    xhr.onload = () => {
      let text = "";
      try { text = JSON.parse(xhr.responseText).error || ""; } catch { /* not JSON */ }
      resolve({ status: xhr.status, message: text });
    };
    xhr.onerror = () => reject(new Error("the connection was lost"));
    xhr.send(file);
  });
}

async function upload(files) {
  const list = Array.from(files);
  if (list.length === 0) return;
  const folder = targetFolder();
  let done = 0;
  const kept = [];
  for (const [i, file] of list.entries()) {
    const parts = folder.concat(file.name);
    const label = "Uploading " + (i + 1) + " of " + list.length + ": " + file.name;
    toast(label);
    try {
      let result = await put(file, parts, false, label);
      if (result.status === 409 && confirm(file.name + " is already in this folder. Replace it?")) result = await put(file, parts, true, label);
      if (result.status === 409) { kept.push(file.name); continue; }
      if (result.status >= 300) throw new Error(result.message || ("HTTP " + result.status));
      done++;
    } catch (error) {
      toast("Could not upload " + file.name + ": " + error.message, "bad");
      await refresh();
      return;
    }
  }
  toast("Uploaded " + done + " of " + list.length + (list.length === 1 ? " file" : " files") + " to " + (folder.join("/") || "Home") + "." +
    (kept.length ? " Left as it was: " + kept.join(", ") + "." : ""), done === list.length ? "ok" : "");
  await refresh();
}

/* ---------- wiring ---------- */

$("toggleTree").append(icon("menu"));
$("toggleTree").addEventListener("click", () => {
  const hiddenNow = document.body.classList.toggle("no-tree");
  store.set("fb-tree", hiddenNow ? "hidden" : "shown");
});
if (store.get("fb-tree") === "hidden" || (store.get("fb-tree") === null && window.innerWidth <= 760)) document.body.classList.add("no-tree");

$("theme").addEventListener("click", () => {
  const now = THEMES.includes(store.get("fb-theme")) ? store.get("fb-theme") : "auto";
  store.set("fb-theme", THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]);
  applyTheme();
});
systemDark.addEventListener("change", applyTheme);
applyTheme();

$("newFolder").addEventListener("click", newFolder);
$("moveFile").addEventListener("click", () => moveEntry(here.parts));
$("pick").addEventListener("change", (e) => { upload(e.target.files); e.target.value = ""; });
$("toast").addEventListener("click", () => toast(""));

$("find").addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 140); });
$("find").addEventListener("focus", () => { if ($("find").value.trim() !== "") runFind(); });
$("find").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveFind(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveFind(-1); }
  else if (e.key === "Escape") { closeFind(); $("find").blur(); }
  else if (e.key === "Enter") {
    const links = [...$("findResults").querySelectorAll("a")];
    const chosen = links[findOn >= 0 ? findOn : 0];
    if (chosen) { location.hash = chosen.getAttribute("href"); $("find").value = ""; $("find").blur(); }
  }
});
$("findResults").addEventListener("click", () => { $("find").value = ""; });
document.addEventListener("click", (e) => { if (!e.target.closest(".find")) closeFind(); });
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "t" || e.key === "/")) { e.preventDefault(); $("find").focus(); }
});

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropWhere").textContent = targetFolder().join("/") || "Home";
  $("drop").hidden = false;
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  upload(e.dataTransfer.files);
});

window.addEventListener("hashchange", show);
show();
