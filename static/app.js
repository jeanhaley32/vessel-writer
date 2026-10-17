// vessel-writer — distraction-free editor + inline file management (no dialogs).
import {
  Y, EditorView, EditorState, keymap, defaultKeymap, history as cmHistory, historyKeymap,
  indentWithTab, markdown, syntaxHighlighting, defaultHighlightStyle, yCollab,
  Awareness, encodeAwarenessUpdate, applyAwarenessUpdate,
} from "./vendor/editor/vessel-editor.bundle.mjs";
import { commentExtensions, commentsAttach, commentsDetach } from "./comments.js?v=brd1";
import { imageExtensions } from "./images.js?v=brd1";
import { authorshipExtension } from "./authorship.js?v=brd1";

const $ = (s) => document.querySelector(s);
const editor = $("#editor"), pathInput = $("#path"), statusEl = $("#status"), treeEl = $("#tree"), toastEl = $("#toast");

let current = null;          // open document path
let lastSaved = "";
let saveTimer = null;
let dirty = false;
let selectedFolder = "";     // where "new" actions land; "" = root
let pending = null;          // inline edit: {mode:'newfolder'|'newfile'|'rename', parent, oldPath, isDir}
let dragPath = null;
let previewing = null;       // {hash, at} while viewing (read-only) an earlier version
let currentHash = null;      // hash of the open doc's current version (to detect external changes)
let ydoc = null, ytext = null;  // the open doc's CRDT (bound to CodeMirror via yCollab)
let ySession = null;         // id of the server's live session this tab joined
let yWriter = null;          // the session's own Yjs client id: text it created is the assistant's
let lastStructJSON = "";     // last-seen /api/structure, for change polling
let viewMode = false;        // reading view (rendered markdown) instead of the editor
const viewBtn = $("#view-btn"), preview = $("#preview");
const expanded = new Set(JSON.parse(localStorage.getItem("vw_expanded") || "[]"));

// --- relayC layout mode ---
// One owner for this state: app.js holds it and persists it, panel.js only
// applies it. Two writers to one key is how the chat pane's saved geometry
// would get clobbered. The writer is always in one of two modes, and a single
// toggle shows which and switches to the other. Anything else stored (an old
// "", junk) reads as writer.
const MODE_KEY = "vw_mode";
// Board mode is Write mode with the board beside the document: the chat
// renders exactly as in Write mode, and the toggle leads back to Write.
const MODES = { writer: "chat", chat: "writer", board: "writer" };   // each mode -> the one its toggle leads to
const MODE_LABEL = { writer: "Write", chat: "Chat", board: "Board" };
let mode = MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : "writer";

function applyMode() {
  for (const b of document.querySelectorAll(".mode-toggle")) {
    b.textContent = MODE_LABEL[mode];
    b.dataset.mode = mode;
    b.title = `${MODE_LABEL[mode]} mode. Click for ${MODE_LABEL[MODES[mode]]} mode`;
  }
  document.body.classList.toggle("mode-board", mode === "board");
  window.vesselChat?.setMode(mode === "board" ? "writer" : mode);
  window.vesselBoard?.setOpen(mode === "board");
}

function setMode(next) {
  if (!MODES[next]) return;
  mode = next;
  localStorage.setItem(MODE_KEY, mode);
  applyMode();
}
const toggleMode = () => setMode(MODES[mode]);

document.addEventListener("click", (e) => {
  if (e.target.closest(".mode-toggle")) toggleMode();
  else if (e.target.closest("#board-btn")) setMode(mode === "board" ? "writer" : "board");
});

// panel.js mounts on DOMContentLoaded too, so defer the first apply until
// window.vesselChat exists rather than racing it.
window.addEventListener("load", applyMode);

// --- client logging: ship errors + key editor events to the server log so the
// writer is troubleshootable without the browser console ---
function clog(level, msg) {
  try {
    fetch("api/clientlog", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, msg: String(msg).slice(0, 1500) }) }).catch(() => {});
  } catch (_) {}
}
window.addEventListener("error", (e) => clog("error", `${e.message} @${e.filename}:${e.lineno}:${e.colno} ${(e.error && e.error.stack) || ""}`));
window.addEventListener("unhandledrejection", (e) => clog("error", "unhandledrejection: " + ((e.reason && e.reason.stack) || e.reason)));
clog("info", "app loaded");

let statusFade = null;
const setStatus = (t) => {
  statusEl.textContent = t;
  statusEl.classList.add("busy");
  clearTimeout(statusFade);
  if (!/…$/.test(t)) statusFade = setTimeout(() => statusEl.classList.remove("busy"), 1800);
};
const persistExpanded = () => localStorage.setItem("vw_expanded", JSON.stringify([...expanded]));
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const parentOf = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.status === 200 ? r.json() : null;
}

// --- toast (used for undoable delete) ---
let toastTimer = null;
function toast(msg, actionLabel, actionFn) {
  toastEl.innerHTML = "";
  toastEl.append(document.createTextNode(msg));
  if (actionLabel) {
    const b = document.createElement("button");
    b.textContent = actionLabel;
    b.onclick = () => { clearTimeout(toastTimer); toastEl.hidden = true; actionFn(); };
    toastEl.append(b);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.hidden = true, 6000);
}

// --- tree model ---
function buildTree(folders, docs) {
  const root = { name: "", path: "", dir: true, children: new Map() };
  const ensure = (parts) => {
    let node = root, acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      if (!node.children.has(part))
        node.children.set(part, { name: part, path: acc, dir: true, children: new Map() });
      node = node.children.get(part);
    }
    return node;
  };
  for (const f of folders) ensure(f.split("/"));
  for (const d of docs) {
    const parts = d.path.split("/"), name = parts.pop();
    (parts.length ? ensure(parts) : root).children.set(name, { name, path: d.path, dir: false, doc: d });
  }
  return root;
}
const sortedChildren = (node) => [...node.children.values()].sort((a, b) =>
  (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));

function inputRow(depth, initial, onCommit) {
  const row = document.createElement("div");
  row.className = "node editing";
  row.style.paddingLeft = (0.6 + depth * 0.9) + "rem";
  const inp = document.createElement("input");
  inp.className = "inline-edit"; inp.value = initial; inp.spellcheck = false;
  const done = (commit) => { pending = null; if (commit && inp.value.trim()) onCommit(inp.value.trim()); else render(); };
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); }
                           else if (e.key === "Escape") { e.preventDefault(); done(false); } };
  inp.onblur = () => done(true);
  row.appendChild(inp);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  return row;
}

function renderNode(node, container, depth) {
  // inline "new item" input as first child of its target parent
  if (pending && (pending.mode === "newfolder" || pending.mode === "newfile") && pending.parent === node.path) {
    const isFolder = pending.mode === "newfolder";
    container.appendChild(inputRow(depth, "", (name) => {
      const path = (node.path ? node.path + "/" : "") + name + (isFolder ? "" : (name.endsWith(".md") ? "" : ".md"));
      isFolder ? createFolder(path) : createFile(path);
    }));
  }
  for (const child of sortedChildren(node)) {
    if (pending && pending.mode === "rename" && pending.oldPath === child.path) {
      container.appendChild(inputRow(depth, child.name, (name) => {
        const np = (parentOf(child.path) ? parentOf(child.path) + "/" : "") + name;
        if (np !== child.path) move(child.path, np); else render();
      }));
      if (child.dir && expanded.has(child.path)) renderNode(child, container, depth + 1);
      continue;
    }
    const row = document.createElement("div");
    row.className = "node " + (child.dir ? "folder" : "file");
    row.style.paddingLeft = (0.6 + depth * 0.9) + "rem";
    row.dataset.path = child.path;
    const caret = child.dir ? (expanded.has(child.path) ? "▾" : "▸") : "";
    row.innerHTML = `<span class="caret">${caret}</span><span class="label">${escapeHtml(child.name)}</span>`;
    if (child.dir) {
      row.onclick = (e) => { e.stopPropagation(); selectedFolder = child.path;
        expanded.has(child.path) ? expanded.delete(child.path) : expanded.add(child.path);
        persistExpanded(); render(); };
      row.ondragover = (e) => { e.preventDefault(); row.classList.add("drop"); };
      row.ondragleave = () => row.classList.remove("drop");
      row.ondrop = (e) => { e.preventDefault(); row.classList.remove("drop"); onDrop(child.path); };
    } else {
      if (child.path === current) row.classList.add("active");
      row.onclick = (e) => { e.stopPropagation(); openDoc(child.path); };
      row.draggable = true;
      row.ondragstart = () => dragPath = child.path;
    }
    row.appendChild(rowActions(child));
    container.appendChild(row);
    if (child.dir && expanded.has(child.path)) renderNode(child, container, depth + 1);
  }
}

function rowActions(child) {
  const box = document.createElement("span");
  box.className = "row-actions";
  if (child.dir) {
    const nf = document.createElement("button");
    nf.textContent = "+"; nf.title = "New file here";
    nf.onclick = (e) => { e.stopPropagation(); selectedFolder = child.path; expanded.add(child.path); newDoc(); };
    box.append(nf);
  }
  const rename = document.createElement("button");
  rename.textContent = "✎"; rename.title = "Rename";
  rename.onclick = (e) => { e.stopPropagation(); pending = { mode: "rename", oldPath: child.path }; render(); };
  const del = document.createElement("button");
  del.textContent = "×"; del.title = "Delete";
  del.onclick = (e) => { e.stopPropagation(); doDelete(child); };
  box.append(rename, del);
  return box;
}

function onDrop(folderPath) {
  if (!dragPath) return;
  const dest = (folderPath ? folderPath + "/" : "") + nameOf(dragPath);
  if (dest !== dragPath) move(dragPath, dest);
  dragPath = null;
}

function drawTree(structure) {
  const root = buildTree(structure.folders || [], structure.documents || []);
  treeEl.innerHTML = "";
  renderNode(root, treeEl, 0);
}

async function render() {
  drawTree(await api("GET", "api/structure"));
}

// --- ops ---
async function createFolder(path) { await api("POST", "api/mkdir", { path }); expanded.add(path); persistExpanded(); render(); }
async function createFile(path) {
  await api("PUT", "api/doc", { path, content: "" });
  render(); openDoc(path);
}
function newFolder() { pending = { mode: "newfolder", parent: selectedFolder }; if (selectedFolder) expanded.add(selectedFolder); render(); }
function newDoc() { pending = { mode: "newfile", parent: selectedFolder }; if (selectedFolder) expanded.add(selectedFolder); render(); }

async function move(oldPath, newPath) {
  try {
    await api("POST", "api/move", { old: oldPath, new: newPath });
    if (current === oldPath) { current = newPath; pathInput.value = newPath; }
    setStatus("moved"); render();
  } catch (e) { setStatus("move failed"); console.error(e); }
}

async function doDelete(child) {
  try { await deleteNode(child); } catch (e) { setStatus("delete failed"); console.error(e); }
  render();
}

async function deleteNode(child) {
  if (child.dir) {
    const res = await api("POST", "api/rmdir", { path: child.path, recursive: true });
    const docs = (res && res.deleted_docs) || [];
    toast(`Deleted folder “${child.name}”`, "Undo", async () => {
      await api("POST", "api/mkdir", { path: child.path });
      for (const d of docs) await api("POST", "api/undelete", { path: d });  // restore its files too
      render();
    });
  } else {
    await api("POST", "api/delete", { path: child.path });
    if (current === child.path) { current = null; teardownEditor(); editor.innerHTML = ""; pathInput.value = ""; lastSaved = ""; }
    toast(`Deleted “${child.name}”`, "Undo", async () => { await api("POST", "api/undelete", { path: child.path }); render(); });
  }
}

const docOpenedHandlers = [];

async function openDoc(path) {
  if (previewing) exitPreview(true);   // leave preview before switching files
  if (dirty) await save(true);
  const doc = await api("GET", "api/doc?collab=1&path=" + encodeURIComponent(path));
  current = doc.path; pathInput.value = doc.path;
  lastSaved = doc.content; currentHash = doc.hash; dirty = false; setStatus("opened");
  await buildEditor(doc.path, doc.content, doc.yseed, doc.ysession, doc.ywriter);   // CodeMirror + live CRDT for this document
  selectedFolder = parentOf(path); render();
  if (viewMode) renderPreview();   // keep the reading view in sync when switching docs
  // A listener must never be able to stop a document opening.
  for (const fn of docOpenedHandlers) {
    try { fn(doc.path); } catch (e) { console.error("onDocOpened listener failed", e); }
  }
}

async function save(immediate) {
  if (previewing) return;              // never write while viewing history
  const path = pathInput.value.trim(), content = getContent();
  if (!path) { setStatus("needs a path"); return; }
  // SAFETY GUARD: never let autosave write an empty document over one that had
  // content — a blank open / seeding glitch must never be able to truncate a file.
  if (content.trim() === "" && lastSaved && lastSaved.trim() !== "") {
    clog("warn", "BLOCKED empty-overwrite save of " + path + " (lastSaved had " + lastSaved.length + " chars)");
    setStatus("save held (blank)"); dirty = false; return;
  }
  if (content === lastSaved && path === current) { dirty = false; setStatus("saved"); return; }
  setStatus("saving…");
  try {
    const live = ySession && path === yPath;
    const res = await api("PUT", "api/doc", live ? { path, content, collab: true, session: ySession } : { path, content });
    current = res.path; lastSaved = content; currentHash = res.hash; dirty = false;
    setStatus(res.changed ? "saved ✓" : "saved"); render();
  } catch (e) {
    if (String(e.message).includes("live session")) { rejoinSession(); return; }
    setStatus("save failed"); console.error(e);
  }
}

function scheduleSave() { if (previewing) return; dirty = true; setStatus("editing…"); clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false), 1200); }

// --- CodeMirror editor + live CRDT sync (y-codemirror.next) ---
// The open document is a Y.Text bound to a CodeMirror EditorView via yCollab,
// which gives collaborative editing AND remote cursors (via the awareness
// protocol) natively. Our tiny relay carries Yjs doc-updates (/api/yupdate ↔
// /api/ysync) and awareness updates (/api/awareness, tagged "a:" on the same
// stream). The blob store still persists content for history/recall.
let yes = null;             // EventSource (doc updates + awareness) for the open doc
let view = null;            // the CodeMirror EditorView
let awareness = null;
let yPath = null;
let applyingRemote = false; // true while applying a peer's doc update (so we don't re-save it)

const _b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const _unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Deterministic seed: encode the blob content as a Yjs update from a FIXED
// clientID, so every client that opens the same document produces the byte-
// identical seed operation. Applying it on every client is idempotent (Yjs
// dedups by clientID+clock) — so all peers share one ID base with no doubling,
// and a document can never open blank (each client seeds itself). Edits use
// each doc's own random clientID and layer on top.
function seedUpdate(content) {
  const tmp = new Y.Doc();
  tmp.clientID = 0;
  tmp.getText("content").insert(0, content);
  return Y.encodeStateAsUpdate(tmp);
}
const USER_COLORS = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085"];
const myColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

function getContent() { return ytext ? ytext.toString() : (view ? view.state.doc.toString() : ""); }
function focusEditor() { try { view && view.focus(); } catch (_) {} }

function teardownEditor() {
  try { commentsDetach(); } catch (e) { console.error("comment layer detach failed", e); }
  try { if (yes) yes.close(); } catch (_) {}
  try { if (view) view.destroy(); } catch (_) {}
  try { if (ydoc) ydoc.destroy(); } catch (_) {}
  yes = null; view = null; ydoc = null; ytext = null; awareness = null; yPath = null; ySession = null; yWriter = null;
}

// The server's session ended or was replaced (restart, move, delete). This tab's
// CRDT history no longer matches it, so hand any local text to the server as an
// ordinary write, then reopen and join the current session.
let rejoining = false;
async function rejoinSession() {
  if (rejoining || !current) return;
  rejoining = true;
  try {
    const path = current, content = getContent();
    if (content !== lastSaved && content.trim() !== "") {
      await api("PUT", "api/doc", { path, content, external: true }).catch(() => {});
    }
    dirty = false;
    await openDoc(path);
    clog("info", `rejoined live session for ${path}`);
  } finally { rejoining = false; }
}

async function buildEditor(path, content, yseed, session, writer) {
  teardownEditor();
  yPath = path;
  ySession = session || null;
  yWriter = writer ?? null;
  ydoc = new Y.Doc();
  ytext = ydoc.getText("content");
  awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: (window.vesselConfig || {}).owner || "You", color: myColor, colorLight: myColor + "33" });

  // Seed every client deterministically from the blob (idempotent, shared IDs) —
  // origin "seed" so it is NOT re-posted to peers (each client seeds itself; the
  // sync log carries only real edits). No blank opens, no double-seed race.
  // With a live session the server supplies the seed, so every tab and the
  // server share one starting history even if the saved text has moved on.
  if (yseed) Y.applyUpdate(ydoc, _unb64(yseed), "seed");
  else if (content) Y.applyUpdate(ydoc, seedUpdate(content), "seed");
  clog("info", `open ${path}: blobLen=${(content || "").length} ytextLen=${ytext.length}`);

  // local doc updates → peers (remote-origin updates don't echo back)
  ydoc.on("update", (update, origin) => {
    if (origin === "remote" || origin === "seed") return;   // don't echo remote or re-post the local seed
    fetch("api/yupdate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, update: _b64(update), v: 2 }) }).catch(() => {});
  });
  // local awareness (cursor) → peers
  awareness.on("update", ({ added, updated, removed }, origin) => {
    if (origin === "remote") return;
    const changed = added.concat(updated, removed);
    fetch("api/awareness", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, update: _b64(encodeAwarenessUpdate(awareness, changed)) }) }).catch(() => {});
  });

  view = new EditorView({
    parent: editor,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        cmHistory(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        yCollab(ytext, awareness),
        ...(() => { try { return commentExtensions(); } catch (e) { console.error("comment layer unavailable", e); return []; } })(),
        imageExtensions((msg) => toast(msg)),
        authorshipExtension(() => (ytext ? { ytext, client: yWriter } : null)),
        EditorView.updateListener.of((u) => { if (u.docChanged && !applyingRemote) scheduleSave(); }),
      ],
    }),
  });

  try { commentsAttach(view, path); } catch (e) { console.error("comment layer attach failed", e); }

  // peers: doc updates (untagged) + awareness ("a:"-tagged) on the same stream
  yes = new EventSource("api/ysync?v=2&path=" + encodeURIComponent(path));
  yes.onmessage = (e) => {
    try {
      if (e.data.startsWith("s:")) {
        if (e.data.slice(2) !== ySession) rejoinSession();
      } else if (e.data.startsWith("a:")) {
        applyAwarenessUpdate(awareness, _unb64(e.data.slice(2)), "remote");
      } else {
        applyingRemote = true;
        try { Y.applyUpdate(ydoc, _unb64(e.data), "remote"); } finally { applyingRemote = false; }
      }
    } catch (err) { clog("error", "ysync apply failed: " + err); }
  };
  focusEditor();
}

pathInput.addEventListener("change", () => { current = null; scheduleSave(); });
$("#new-doc").onclick = () => { selectedFolder = ""; newDoc(); };
$("#new-folder").onclick = () => { selectedFolder = ""; newFolder(); };
// On a phone the sidebar is a drawer over the page, so the same button opens
// and closes that instead of zen. The drawer is never persisted: a fold or an
// unfold changes which of the two the button means, and the page follows.
const NARROW = window.matchMedia("(max-width: 640px)");
const sidebarEl = $("#sidebar");
const toggleSideBtn = $("#toggle-side");
toggleSideBtn.onclick = () => document.body.classList.toggle(NARROW.matches ? "side-open" : "zen");
const closeDrawer = () => document.body.classList.remove("side-open");
NARROW.addEventListener("change", closeDrawer);
docOpenedHandlers.push(() => { if (NARROW.matches) closeDrawer(); });
document.addEventListener("click", (e) => {
  if (NARROW.matches && !sidebarEl.contains(e.target) && !toggleSideBtn.contains(e.target)) closeDrawer();
});

// --- fullscreen writer ---
// The chat's setFull pattern: one body class, one flag, and nothing about the
// layout underneath is written, so leaving returns to the mode, zen state and
// chat geometry that were there. It supersedes zen rather than composing with
// it, because zen hides the header until hovered and touch cannot hover.
const WRITER_FULL_KEY = "vw_writer_full";
const fullBtn = $("#full-btn");
function setWriterFull(on) {
  document.body.classList.toggle("writer-full", on);
  localStorage.setItem(WRITER_FULL_KEY, JSON.stringify(on));
  fullBtn.setAttribute("aria-pressed", String(on));
  if (on) closeDrawer();
  focusEditor();
}
fullBtn.onclick = () => setWriterFull(!document.body.classList.contains("writer-full"));
if (localStorage.getItem(WRITER_FULL_KEY) === "true") setWriterFull(true);

// resizable sidebar: a grip pinned to the sidebar's right edge sets --sidebar-w.
(function () {
  const savedW = parseInt(localStorage.getItem("vw_sidebar_w"), 10);
  if (Number.isFinite(savedW)) document.documentElement.style.setProperty("--sidebar-w", savedW + "px");
  const grip = document.createElement("div");
  grip.id = "sidebar-grip"; grip.title = "Drag to resize";
  document.body.appendChild(grip);
  let dragging = false;
  grip.addEventListener("pointerdown", (e) => { dragging = true; document.body.classList.add("col-resizing"); e.preventDefault(); });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(e.clientX, 480));
    document.documentElement.style.setProperty("--sidebar-w", w + "px");
  });
  const release = () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove("col-resizing");
    const w = parseInt(document.documentElement.style.getPropertyValue("--sidebar-w"), 10);
    if (Number.isFinite(w)) localStorage.setItem("vw_sidebar_w", w);
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
})();
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(true); }
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); document.body.classList.toggle("zen"); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyN") { e.preventDefault(); selectedFolder = ""; newDoc(); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyF") { e.preventDefault(); setWriterFull(!document.body.classList.contains("writer-full")); }
  // a popover's own Escape handler closes it; only a bare Escape leaves
  // fullscreen, and that Escape is spent: the chat and the rail register their
  // own Escape handlers later (on DOMContentLoaded) and must not act on it,
  // since whatever they would leave is not on screen under fullscreen
  if (e.key === "Escape" && document.body.classList.contains("writer-full")
      && !document.querySelector("#help:not([hidden]), #history:not([hidden]), #appearance:not([hidden])")) {
    e.preventDefault(); e.stopImmediatePropagation(); setWriterFull(false);
  }
});
// The activity rail lives in static/rail.js.

window.addEventListener("beforeunload", () => { if (dirty) save(true); });

// --- appearance (theme + typeface), persisted locally ---
const appearanceBtn = $("#appearance-btn"), appearancePop = $("#appearance");
const prefs = {
  theme: localStorage.getItem("vw_theme") || "system",
  font: localStorage.getItem("vw_font") || "book",
  width: localStorage.getItem("vw_width") || "centered",
};
function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prefs.theme);
  root.setAttribute("data-font", prefs.font);
  root.setAttribute("data-width", prefs.width);
  for (const group of appearancePop.querySelectorAll(".choice-group")) {
    const kind = group.dataset.kind;
    for (const b of group.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.value === prefs[kind]));
  }
}
// --- editor text size: the same A−/A+ stepper as the chat, one px a step ---
const EDITOR_FS_MIN = 12, EDITOR_FS_MAX = 32;
const LEGACY_ESIZE = { small: 16, large: 22 };   // the old Small/Normal/Large presets
function editorFs() {
  const v = Number(localStorage.getItem("vw_editor_fs"));
  if (Number.isFinite(v) && v > 0) return v;
  return LEGACY_ESIZE[localStorage.getItem("vw_esize")] || null;   // null: the typeface default
}
function applyEditorFs() {
  const v = editorFs(), root = document.documentElement;
  if (v) { root.setAttribute("data-efs", ""); root.style.setProperty("--editor-fs", v + "px"); }
  else { root.removeAttribute("data-efs"); root.style.removeProperty("--editor-fs"); }
}
function bumpEditorFs(delta) {
  const scroller = document.querySelector(".cm-scroller");
  const start = editorFs() || (scroller ? Math.round(parseFloat(getComputedStyle(scroller).fontSize)) : 19);
  const next = Math.max(EDITOR_FS_MIN, Math.min(EDITOR_FS_MAX, start + delta));
  localStorage.setItem("vw_editor_fs", String(next));
  localStorage.removeItem("vw_esize");
  applyEditorFs();
}
$("#editor-fs-dec").onclick = () => bumpEditorFs(-1);
$("#editor-fs-inc").onclick = () => bumpEditorFs(+1);
applyEditorFs();

appearancePop.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-value]");
  if (!b) return;
  const kind = b.closest(".choice-group").dataset.kind;
  prefs[kind] = b.dataset.value;
  localStorage.setItem("vw_" + kind, prefs[kind]);
  applyPrefs();
});
function toggleAppearance(open) {
  const show = open ?? appearancePop.hidden;
  appearancePop.hidden = !show;
  appearanceBtn.setAttribute("aria-expanded", String(show));
}
appearanceBtn.onclick = (e) => { e.stopPropagation(); toggleAppearance(); };
document.addEventListener("click", (e) => {
  if (!appearancePop.hidden && !appearancePop.contains(e.target)) toggleAppearance(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !appearancePop.hidden) { toggleAppearance(false); focusEditor(); }
});
applyPrefs();

// --- version history (view earlier versions of the open doc, restore one) ---
const historyBtn = $("#history-btn"), historyPop = $("#history"), historyList = $("#history-list");
const previewBar = $("#preview-bar"), previewLabel = $("#preview-label");

const fmtWhen = (at) => new Date(at * 1000).toLocaleString([], {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function openHistory() {
  if (!current) { historyList.innerHTML = '<div id="history-empty">Open a document to see its history.</div>'; }
  else {
    const { versions } = await api("GET", "api/history?path=" + encodeURIComponent(current));
    if (!versions.length) historyList.innerHTML = '<div id="history-empty">No saved versions yet.</div>';
    else {
      historyList.innerHTML = "";
      versions.forEach((v, i) => {
        const row = document.createElement("button");
        row.className = "vrow" + (i === 0 && !previewing ? " is-current" : "");
        row.innerHTML = `<span class="vwhen">${fmtWhen(v.at)}</span>` +
          (i === 0 ? '<span class="vtag">current</span>' :
           (previewing && previewing.hash === v.hash ? '<span class="vtag">viewing</span>' : ""));
        if (!(i === 0 && !previewing)) row.onclick = () => previewVersion(v);
        historyList.append(row);
      });
    }
  }
  historyPop.hidden = false; historyBtn.setAttribute("aria-expanded", "true");
}
function closeHistory() { historyPop.hidden = true; historyBtn.setAttribute("aria-expanded", "false"); }

async function previewVersion(v) {
  const res = await api("GET", `api/version?path=${encodeURIComponent(current)}&hash=${v.hash}`);
  previewing = { ...v, content: res.content };
  document.body.classList.add("previewing");
  editor.hidden = true;                 // hide the live editor
  preview.hidden = false;               // show the old version, read-only, as plain text
  preview.classList.add("raw");
  preview.textContent = res.content;
  previewLabel.textContent = `Viewing version from ${fmtWhen(v.at)} — read-only`;
  previewBar.hidden = false;
  closeHistory(); setStatus("history");
}

function exitPreview(silent) {
  if (!previewing) return;
  previewing = null;
  document.body.classList.remove("previewing");
  previewBar.hidden = true;
  preview.classList.remove("raw");
  if (viewMode) { renderPreview(); editor.hidden = true; preview.hidden = false; }
  else { preview.hidden = true; editor.hidden = false; if (!silent) { setStatus("current"); focusEditor(); } }
}

async function restoreVersion() {
  if (!previewing || !current || !ytext) return;
  const content = previewing.content;
  previewing = null; document.body.classList.remove("previewing");
  previewBar.hidden = true; preview.classList.remove("raw"); preview.hidden = true; editor.hidden = false;
  // replace the live CRDT text with the old version → propagates to peers + persists as a new version
  ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, content); });
  setStatus("restored ✓"); save(true); focusEditor();
}

historyBtn.onclick = (e) => { e.stopPropagation(); historyPop.hidden ? openHistory() : closeHistory(); };
$("#preview-restore").onclick = restoreVersion;
$("#preview-exit").onclick = () => exitPreview(false);
document.addEventListener("click", (e) => {
  if (!historyPop.hidden && !historyPop.contains(e.target) && e.target !== historyBtn) closeHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!historyPop.hidden) closeHistory();
  else if (previewing) exitPreview(false);
});

// --- reading view: rendered markdown ↔ plain-text editing ---
// The reading view renders markdown that other writers (Rodin, scripts) can
// author, into the writer's own origin, so it is cleaned before it is shown:
// no active elements, no event handlers, and links and images may only point at
// http(s), mailto, or this site.
const UNSAFE_ELEMENTS = "script,style,iframe,object,embed,link,meta,base,form,svg,math";
const SAFE_URL = /^(https?:|mailto:|#|\/|\.{0,2}\/|api\/|static\/|[^:]*$)/i;
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(UNSAFE_ELEMENTS).forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) {
      const isUrl = /^(href|src|xlink:href|action|formaction|srcset)$/i.test(a.name);
      if (/^on/i.test(a.name) || (isUrl && !SAFE_URL.test(a.value.trim()))) n.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}
function renderPreview() {
  const md = getContent();
  preview.classList.remove("raw");
  preview.innerHTML = window.marked ? sanitize(marked.parse(md, { gfm: true })) : md;
  renderMermaid();
}
function renderMermaid() {
  if (!window.mermaid) return;
  const codes = preview.querySelectorAll("pre > code.language-mermaid, code.language-mermaid");
  if (!codes.length) return;
  codes.forEach((code) => {
    const holder = document.createElement("div");
    holder.className = "mermaid";
    holder.textContent = code.textContent;
    (code.closest("pre") || code).replaceWith(holder);
  });
  const dt = document.documentElement.getAttribute("data-theme");
  const theme = (dt === "dark" || dt === "night") ? "dark"
    : (dt === "sepia") ? "neutral"
    : (dt ? "default" : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default"));
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    mermaid.run({ nodes: preview.querySelectorAll(".mermaid"), suppressErrors: true });
  } catch (e) { console.error("mermaid:", e); }
}
function setView(on) {
  if (previewing) return;   // history preview owns the view region
  viewMode = on;
  if (on) renderPreview();
  preview.hidden = !on;
  editor.hidden = on;
  viewBtn.setAttribute("aria-pressed", String(on));
  if (!on) focusEditor();
}
viewBtn.onclick = () => setView(!viewMode);

// --- shortcuts help popover ---
const helpBtn = $("#help-btn"), helpPop = $("#help");
function toggleHelp(open) {
  const show = open ?? helpPop.hidden;
  helpPop.hidden = !show;
  helpBtn.setAttribute("aria-expanded", String(show));
}
helpBtn.onclick = (e) => { e.stopPropagation(); toggleHelp(); };
document.addEventListener("click", (e) => {
  if (!helpPop.hidden && !helpPop.contains(e.target) && e.target !== helpBtn) toggleHelp(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !helpPop.hidden) { toggleHelp(false); }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); setView(!viewMode); }
});

// --- detect external changes (e.g. Rodin writing a doc) and refresh live ---
async function pollChanges() {
  if (pending) return;                       // don't disrupt an inline rename/new-file
  let s;
  try { s = await api("GET", "api/structure"); } catch { return; }
  const j = JSON.stringify(s);
  if (j === lastStructJSON) return;
  lastStructJSON = j;
  drawTree(s);
  // did the open document change underneath us?
  if (!current) return;
  const d = (s.documents || []).find((x) => x.path === current);
  if (!d) return;                            // deletion is handled elsewhere
  if (d.current_hash && d.current_hash !== currentHash) {
    if (ytext && yPath === current) {
      currentHash = d.current_hash;          // CRDT is live-authoritative for the open doc; don't reload under it
    } else if (dirty || previewing) {
      toast("This document changed — reload to see it", "Reload", () => openDoc(current));
    } else {
      openDoc(current);                      // safe: no unsaved edits
    }
  }
}
setInterval(pollChanges, 3000);

(async () => {
  await render();
  try { lastStructJSON = JSON.stringify(await api("GET", "api/structure")); } catch {}
  const firstFile = treeEl.querySelector(".file");
  if (firstFile) openDoc(firstFile.dataset.path); else pathInput.value = "";
})();

// --- the seam other UI modules reach the writer through ---
// app.js is a module and exposed nothing, so every new panel had to be wired
// into this file to open a document. Modules now register themselves and call
// in, which is the idiom panel.js already established with window.vesselChat.
window.vesselWriter = {
  openDoc,
  createFile,
  currentPath: () => current,
  setMode,
  onDocOpened(fn) { docOpenedHandlers.push(fn); },
};
