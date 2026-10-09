// Inline comments — a Decoration.mark layer over the open document.
//
// The one hard rule here: nothing in this file may steal focus, move the caret
// or reflow the text while Jean is typing. That is why
//   - every comment is a `Decoration.mark`, never a widget: a mark styles text
//     that is already on screen, a widget inserts a node and reflows the line;
//   - the mark's icon is a background image, which has no box model, rather
//     than an ::after glyph, which would push the following characters along;
//   - the bubble and the meta panel are absolutely positioned overlays, outside
//     the editor's flow;
//   - every dispatch carries effects only and never a selection;
//   - a comment that arrives mid-keystroke waits in a queue until typing pauses.
import { openComposer } from "./compose.js?v=aud1";
import { Decoration, StateEffect, StateField, EditorView }
  from "./vendor/editor/vessel-editor.bundle.mjs";

const IDLE_MS = 700;          // how long a pause must be before decorations land
const setComments = StateEffect.define();

// The class is the one the ruling names, so anyone verifying against the
// ruling's text finds the marks. A reader's mark must be the same thing the
// spec says it is.
const markFor = (comment) => Decoration.mark({
  class: "cm-comment-mark vw-comment-" + (/^[a-z]+$/.test(comment.kind) ? comment.kind : "note"),
  attributes: { "data-comment": comment.id },
  inclusive: false,
});

const anchored = (comment) => comment.to > comment.from;

function decorationsOf(items) {
  const ranges = items
    .filter(anchored)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((c) => markFor(c).range(c.from, c.to));
  return Decoration.set(ranges, true);
}

const commentField = StateField.define({
  create: () => ({ items: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setComments)) {
        const items = effect.value;
        return { items, decorations: decorationsOf(items) };
      }
    }
    if (!tr.docChanged) return value;
    // Edits move the text a comment is attached to; the span moves with it.
    const items = value.items
      .map((c) => ({ ...c, from: tr.changes.mapPos(c.from, 1), to: tr.changes.mapPos(c.to, -1) }))
      .filter(anchored);
    return { items, decorations: decorationsOf(items) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

let active = null;            // {view, path, items, stream, bubble, meta, queue, lastEdit}

function anchor(view, comment) {
  const doc = view.state.doc;
  const text = doc.toString();
  if (comment.quote) {
    let at = -1;
    if (comment.line) {
      const line = doc.line(Math.min(comment.line, doc.lines));
      at = text.indexOf(comment.quote, line.from);
    }
    if (at < 0) at = text.indexOf(comment.quote);
    if (at >= 0) return { from: at, to: at + comment.quote.length };
  }
  if (comment.line) {
    const line = doc.line(Math.min(comment.line, doc.lines));
    return { from: line.from, to: line.to };
  }
  return null;
}

function applyItems() {
  if (!active) return;
  const { view } = active;
  // A comment is anchored by text search exactly once. After that the field
  // owns its position, remapped through every edit, so a line inserted above
  // or a word changed inside the quote moves the mark instead of re-searching
  // the stale line number or losing the quote. A comment whose quote is not in
  // the text, or whose span the field dropped (its text deleted), is never
  // drawn and never re-searched: it stays listed as a document-level note.
  const live = new Map(view.state.field(commentField).items.map((c) => [c.id, c]));
  const resolved = [];
  const seen = new Set();
  for (const comment of active.items) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    if (live.has(comment.id)) { resolved.push(live.get(comment.id)); continue; }
    if (comment.placed) { resolved.push(anchored(comment) ? { ...comment, from: 0, to: 0, detached: true } : comment); continue; }
    const span = anchor(view, comment);
    resolved.push({ ...comment, from: 0, to: 0, ...span, placed: true });
  }
  active.items = resolved;
  // Effects only, never a caret move: a comment cannot relocate the cursor.
  view.dispatch({ effects: setComments.of(resolved.filter(anchored)) });
  renderMeta();
}

function flushWhenIdle() {
  if (!active || !active.queue.length) return;
  clearTimeout(active.timer);
  const wait = Math.max(0, IDLE_MS - (Date.now() - active.lastEdit));
  active.timer = setTimeout(() => {
    if (!active) return;
    if (active.view.composing || Date.now() - active.lastEdit < IDLE_MS) { flushWhenIdle(); return; }
    const fresh = active.queue.some((c) => !c.backlog && c.author !== "jean");   // your own comment is not news
    active.items = active.items.concat(active.queue);
    active.queue = [];
    applyItems();
    if (fresh) showMeta();   // the toast is for something that just arrived, not the backlog on open
    if (active.openOnArrival && findComment(active.openOnArrival)) { openThread(active.openOnArrival, null, true); active.openOnArrival = null; }
  }, wait || 16);
}

// --- overlays -------------------------------------------------------------

function ensureOverlays() {
  const host = document.querySelector("#main") || document.body;
  if (!active.bubble) {
    active.bubble = document.createElement("div");
    active.bubble.className = "vw-comment-bubble";
    active.bubble.hidden = true;
    host.appendChild(active.bubble);
  }
  if (!active.meta) {
    active.meta = document.createElement("aside");
    active.meta.className = "vw-comment-meta";
    active.meta.hidden = true;
    host.appendChild(active.meta);
    // Reading it holds it open; the fade starts again when the pointer leaves.
    active.meta.addEventListener("mouseenter", () => {
      if (!active) return;
      clearTimeout(active.fadeTimer); clearTimeout(active.hideTimer);
      active.meta.classList.remove("fading");
    });
    active.meta.addEventListener("mouseleave", () => { if (active && !active.meta.hidden) armFade(); });
    // The header wraps to two rows in chat mode, so a fixed top would sit over
    // its controls and swallow the clicks — including the mode switch itself.
    const bar = document.querySelector("#bar");
    if (bar) {
      const place = () => active.meta.style.top = (bar.offsetHeight + 6) + "px";
      place();
      try {
        active.barWatch = new ResizeObserver(place);
        active.barWatch.observe(bar);
      } catch (_) {}
    }
  }
}

function showBubble(el, comment) {
  const bubble = active.bubble;
  bubble.textContent = comment.text;
  bubble.dataset.kind = comment.kind || "note";
  bubble.hidden = false;
  const host = bubble.offsetParent || document.body;
  const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
  const top = r.bottom - h.top + 6;
  const left = Math.max(8, Math.min(r.left - h.left, h.width - bubble.offsetWidth - 8));
  bubble.style.top = top + "px";
  bubble.style.left = left + "px";
}

function onOver(event) {
  if (!active) return;
  const el = event.target.closest && event.target.closest(".cm-comment-mark");
  if (!el) { if (active.bubble) active.bubble.hidden = true; return; }
  if (active.thread) return;   // the open thread is the detail view
  const comment = active.items.find((c) => c.id === el.dataset.comment);
  if (comment) showBubble(el, comment);
}

function onLeave() { if (active && active.bubble) active.bubble.hidden = true; }

// --- the panel: a toast on arrival, an index on demand ------------------------

const FADE_MS = 6000, FADE_ANIM_MS = 500;
const snippet = (text, n = 90) => (text.length > n ? text.slice(0, n) + "…" : text);

function armFade() {
  if (!active || !active.meta) return;
  clearTimeout(active.fadeTimer); clearTimeout(active.hideTimer);
  active.meta.classList.remove("fading");
  if (active.pinned) return;
  active.fadeTimer = setTimeout(() => {
    if (!active) return;
    active.meta.classList.add("fading");
    active.hideTimer = setTimeout(() => {
      if (!active || active.pinned) return;
      active.meta.hidden = true;
      active.meta.classList.remove("fading");
    }, FADE_ANIM_MS);
  }, FADE_MS);
}

// Called when something new arrives. Shows the panel and starts it fading out.
function showMeta() {
  if (!active || !active.meta) return;
  renderMeta(true);
  armFade();
}

function updateButton() {
  const btn = document.getElementById("comments-btn");
  if (!btn || !active) return;
  const count = active.items.length;
  btn.hidden = count === 0;
  btn.querySelector(".count").textContent = String(count);
  btn.setAttribute("aria-pressed", String(!!active.pinned));
}

function renderMeta(reveal) {
  if (!active || !active.meta) return;
  updateButton();
  const { thinking, summary } = active.metaText;
  const count = active.items.length;
  if (!thinking && !summary && !count) { active.meta.hidden = true; active.pinned = false; return; }
  // Rebuild only what is showing: a quiet change must not pop a faded panel back up.
  if (!reveal && active.meta.hidden && !active.pinned) return;
  active.meta.hidden = false;
  active.meta.innerHTML = "";
  const head = document.createElement("div");
  head.className = "vw-meta-head";
  head.textContent = count === 1 ? "1 comment" : count + " comments";
  active.meta.appendChild(head);
  for (const comment of active.items) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "vw-meta-item";
    el.dataset.comment = comment.id;
    const replies = (comment.replies || []).length;
    el.textContent = (comment.detached ? "detached: " : "") + snippet(comment.text) + (replies ? "  · " + replies + (replies === 1 ? " reply" : " replies") : "");
    el.onclick = () => openThread(comment.id, null, true);
    active.meta.appendChild(el);
  }
  if (summary) {
    const el = document.createElement("div");
    el.className = "vw-meta-summary";
    el.textContent = summary;
    active.meta.appendChild(el);
  }
  if (thinking) {
    const el = document.createElement("div");
    el.className = "vw-meta-thinking";
    el.textContent = thinking;
    active.meta.appendChild(el);
  }
}

function togglePinned() {
  if (!active || !active.meta) return;
  active.pinned = !active.pinned;
  if (active.pinned) { clearTimeout(active.fadeTimer); clearTimeout(active.hideTimer); active.meta.classList.remove("fading"); renderMeta(true); }
  else { active.meta.hidden = true; }
  updateButton();
}
document.getElementById("comments-btn")?.addEventListener("click", togglePinned);

// --- the thread: a comment and a small conversation under it ---------------------

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.json();
}

const findComment = (id) => (active && (active.items.find((c) => c.id === id) || active.queue.find((c) => c.id === id))) || null;

// The only place this file moves focus: into the reply box Jean opened or is
// typing in. An arriving comment, a flush or a reply never calls it.
function focusReply() {
  const box = active && active.thread && active.thread.querySelector("textarea");
  if (box) box.focus();
}

function closeThread() {
  if (!active || !active.thread) return;
  try { active.thread.remove(); } catch (_) {}
  active.thread = null; active.threadId = null;
}

function renderThread() {
  if (!active || !active.thread) return;
  const comment = findComment(active.threadId);
  if (!comment) { closeThread(); return; }
  const box = active.thread;
  const draft = active.drafts[comment.id] || "";   // held outside the box, so a re-render never loses or resurrects text
  const refocus = box.contains(document.activeElement);
  box.innerHTML = "";
  box.dataset.kind = comment.kind || "note";

  const head = document.createElement("div");
  head.className = "vw-thread-head";
  const label = document.createElement("span");
  label.textContent = "Comment";
  const dismiss = document.createElement("button");
  dismiss.type = "button"; dismiss.className = "vw-thread-dismiss"; dismiss.textContent = "Dismiss";
  dismiss.title = "Dismiss this comment. It leaves the page and can be restored.";
  dismiss.onclick = async () => {
    const id = comment.id, path = active.path;
    try { await post("api/comments/resolve", { path, id }); } catch (_) { return; }
    if (active && active.path === path) removeComment(id);
  };
  head.append(label, dismiss);
  box.appendChild(head);

  const addMessage = (author, text) => {
    const el = document.createElement("div");
    el.className = "vw-thread-msg vw-from-" + author;
    const who = document.createElement("div");
    who.className = "vw-thread-who";
    who.textContent = author === "jean" ? "You" : "Rodin";
    const body = document.createElement("div");
    body.className = "vw-thread-text";
    body.textContent = text;
    el.append(who, body);
    box.appendChild(el);
  };
  addMessage(comment.author === "jean" ? "jean" : "rodin", comment.text);
  for (const r of comment.replies || []) addMessage(r.author, r.text);

  const form = document.createElement("div");
  form.className = "vw-thread-form";
  const input = document.createElement("textarea");
  input.rows = 2; input.placeholder = "Reply…"; input.value = draft;
  input.setAttribute("aria-label", "Reply to this comment");
  input.addEventListener("input", () => { active.drafts[comment.id] = input.value; });
  const send = document.createElement("button");
  send.type = "button"; send.className = "vw-thread-send"; send.textContent = "Send";
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    const id = comment.id, path = active.path;
    // Clear the box now: the server's own echo of this reply can arrive before
    // the response does and re-render the thread, and the draft must already be gone.
    active.drafts[id] = ""; input.value = "";
    try {
      const res = await post("api/comments/reply", { path, id, text, author: "jean" });
      if (active && active.path === path) addReply(id, { id: res.id, author: "jean", text, at: Date.now() / 1000 });
    } catch (_) {
      // nothing typed is lost: put it back if the person has not started something new
      if (active && active.path === path && !active.drafts[id]) {
        active.drafts[id] = text;
        if (active.threadId === id) renderThread();
      }
    }
    focusReply();
  };
  send.onclick = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.stopPropagation(); closeThread(); }
  });
  form.append(input, send);
  box.appendChild(form);
  if (refocus) focusReply();
  box.scrollTop = box.scrollHeight;
}

function openThread(id, anchorEl, focus) {
  if (!active || !findComment(id)) return false;
  closeThread();
  if (active.bubble) active.bubble.hidden = true;
  const host = document.querySelector("#main") || document.body;
  const box = document.createElement("div");
  box.className = "vw-thread";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Comment thread");
  host.appendChild(box);
  active.thread = box; active.threadId = id;
  renderThread();
  const h = host.getBoundingClientRect();
  const markEl = anchorEl || (active.view.dom.querySelector('[data-comment="' + id + '"]'));
  if (markEl) {
    const r = markEl.getBoundingClientRect();
    box.style.top = Math.max(8, r.bottom - h.top + 6) + "px";
    box.style.left = Math.max(8, Math.min(r.left - h.left, h.width - box.offsetWidth - 8)) + "px";
  } else {
    const bar = document.querySelector("#bar");
    box.style.top = ((bar ? bar.offsetHeight : 40) + 6) + "px";
    box.style.left = Math.max(8, h.width - box.offsetWidth - 16) + "px";
  }
  if (focus) focusReply();
  return true;
}

function addReply(id, reply) {
  const comment = findComment(id);
  if (!comment) return;
  comment.replies = comment.replies || [];
  if (comment.replies.some((r) => r.id === reply.id)) return;   // our own echo from the stream
  comment.replies.push(reply);
  if (active.threadId === id) renderThread();
  renderMeta();
}

function removeComment(id) {
  active.items = active.items.filter((c) => c.id !== id);
  active.queue = active.queue.filter((c) => c.id !== id);
  if (active.threadId === id) closeThread();
  applyItems();
}

// The speech-bubble icon sits at the right edge of a commented span. Clicking
// it opens the thread; clicking the words places the caret as it always did, so
// editing commented text is never intercepted.
const ICON_ZONE_PX = 16;
function onMarkClick(event) {
  if (!active) return;
  const el = event.target.closest && event.target.closest(".cm-comment-mark");
  if (!el) return;
  const rects = Array.from(el.getClientRects());
  const last = rects[rects.length - 1];
  if (last && event.clientX >= last.right - ICON_ZONE_PX && event.clientX <= last.right + 2) {
    openThread(el.dataset.comment, el, true);
  }
}

// A click that lands outside the open thread (and is not on a mark) closes it.
document.addEventListener("mousedown", (e) => {
  if (!active || !active.thread) return;
  if (active.thread.contains(e.target) || (e.target.closest && (e.target.closest(".cm-comment-mark") || e.target.closest(".vw-meta-item")))) return;
  closeThread();
});

// --- writing a comment of your own --------------------------------------------
//
// Select text, then right-click it and choose Comment, or press Ctrl/Cmd+Alt+M.
// The note is anchored the way Rodin's are (by the quoted text, with the line as
// a hint), and Rodin is handed it, so it starts a thread he answers.

let composer = null;

function composeComment() {
  if (!active) return false;
  const path = active.path;
  if (composer) composer.close();
  composer = openComposer({
    view: active.view,
    path,
    post,
    onPosted: (res) => { if (active && active.path === path) active.openOnArrival = res.id; },
    onClose: () => { composer = null; },
  });
  return !!composer;
}

document.addEventListener("keydown", (e) => {
  if (e.code === "KeyM" && e.altKey && (e.ctrlKey || e.metaKey) && active && active.view.hasFocus) {
    e.preventDefault();
    composeComment();
  }
});

// --- transport ------------------------------------------------------------

function receive(event) {
  if (!active) return;
  if (event.type === "comment") {
    if (event.comment.path !== active.path) return;   // never leak onto another document
    event.comment.replies = event.comment.replies || [];
    active.queue.push(event.comment);
    flushWhenIdle();
  } else if (event.type === "meta") {
    if (event.path !== active.path) return;
    active.metaText = { thinking: event.meta.thinking || "", summary: event.meta.summary || "" };
    showMeta();
  } else if (event.type === "reply") {
    if (event.path !== active.path) return;
    addReply(event.id, event.reply);
    if (event.reply.author === "rodin") showMeta();   // a reply from Rodin is news; your own is not
  } else if (event.type === "resolve") {
    if (event.path !== active.path) return;
    if (event.id) removeComment(event.id);
    else {
      active.items = []; active.queue = [];
      active.metaText = { thinking: "", summary: "" };
      closeThread();
      applyItems();
    }
  }
}

async function loadBacklog(path) {
  const res = await fetch("api/comments?path=" + encodeURIComponent(path));
  if (!res.ok) return;
  const data = await res.json();
  if (!active || active.path !== path) return;
  active.queue = active.queue.concat((data.comments || []).map((c) => ({ ...c, replies: c.replies || [], backlog: true })));
  active.metaText = { thinking: (data.meta || {}).thinking || "", summary: (data.meta || {}).summary || "" };
  flushWhenIdle();
}

// --- the seam app.js uses -------------------------------------------------

export function commentExtensions() {
  return [
    commentField,
    EditorView.updateListener.of((u) => {
      // Only Jean's own keystrokes hold a flush back. A peer's edit arriving
      // over yCollab is not him typing, and must not defer his comments.
      const typing = u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
      if (typing && active) { active.lastEdit = Date.now(); flushWhenIdle(); }
    }),
  ];
}

export function commentsAttach(view, path) {
  commentsDetach();
  active = {
    view, path, items: [], queue: [], timer: null, lastEdit: 0,
    bubble: null, meta: null, stream: null, thread: null, threadId: null,
    pinned: false, fadeTimer: null, hideTimer: null, drafts: {},
    metaText: { thinking: "", summary: "" },
  };
  ensureOverlays();
  view.dom.addEventListener("click", onMarkClick);
  view.dom.addEventListener("mouseover", onOver);
  view.dom.addEventListener("mouseleave", onLeave);
  try {
    const stream = new EventSource("api/comments/stream");
    stream.onmessage = (e) => { try { receive(JSON.parse(e.data)); } catch (_) {} };
    stream.onerror = () => {};
    active.stream = stream;
  } catch (_) {}
  loadBacklog(path).catch(() => {});
}

export function commentsDetach() {
  if (!active) return;
  clearTimeout(active.timer); clearTimeout(active.fadeTimer); clearTimeout(active.hideTimer);
  closeThread();
  try { active.stream && active.stream.close(); } catch (_) {}
  try { active.barWatch && active.barWatch.disconnect(); } catch (_) {}
  try {
    active.view.dom.removeEventListener("click", onMarkClick);
    active.view.dom.removeEventListener("mouseover", onOver);
    active.view.dom.removeEventListener("mouseleave", onLeave);
  } catch (_) {}
  for (const el of [active.bubble, active.meta]) { try { el && el.remove(); } catch (_) {} }
  active = null;
  const btn = document.getElementById("comments-btn");
  if (btn) btn.hidden = true;
}

// Test and console seam. Getters, so a hand on the console reads the live
// state by property and is never handed a stale value or a function.
window.vesselComments = {
  get items() { return active ? active.items.map((c) => ({ ...c })) : []; },
  get path() { return active ? active.path : null; },
  get metaVisible() { return !!(active && active.meta && !active.meta.hidden); },
  get threadOpen() { return active ? active.threadId : null; },
  get pinned() { return !!(active && active.pinned); },
  open(id) { return openThread(id, null, false); },
  compose() { return composeComment(); },
  get composing() { return !!composer; },
  get bubbleText() { return active && active.bubble && !active.bubble.hidden ? active.bubble.textContent : null; },
  hover(id) {
    const el = active && active.view.dom.querySelector('[data-comment="' + id + '"]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  },
};
