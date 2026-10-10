// vessel chat pane — a movable, minimizable dock that talks to the relay over
// the tailnet (/relaychat SSE + POST). Portable: no dependencies, no build.
// Exposes window.vesselChat = { toggle, send(text, quote), open, minimize }.
(() => {
  const CONFIG = window.vesselConfig || { owner: "You", assistant: "Assistant", relay: "" };
  const AI = CONFIG.assistant;
  // No relay configured: the chat pane, its button and "Ask" stay hidden, and
  // nothing connects. Comments on a selection still work.
  const HAS_RELAY = !!CONFIG.relay;
  const STREAM = CONFIG.relay + "/stream", SEND = CONFIG.relay + "/send";
  const LS = { pos: "vw_chat_pos", open: "vw_chat_open", min: "vw_chat_min", size: "vw_chat_size", hist: "vw_chat_hist", pillpos: "vw_chat_pillpos", dock: "vw_chat_dock", dockw: "vw_chat_dockw", full: "vw_chat_full", chatfs: "vw_chat_fs", bubblepos: "vw_chat_bubblepos", baropen: "vw_chat_baropen", splith: "vw_chat_splith" };
  const HIST_CAP = 200;
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // --- build DOM ---
  const panel = el("div", { id: "chat-panel", hidden: true });
  panel.innerHTML = `
    <div class="chat-dock-grip" title="Drag to resize"></div>
    <div class="chat-split-grip" title="Drag to resize"></div>
    <div class="chat-head">
      <span class="chat-dot"></span>
      <span class="chat-title">${esc(AI)}</span>
      <button class="mode-toggle chat-to-write" data-mode="chat" title="Chat mode. Click for Write mode">Chat</button>
      <button class="fs-step chat-fs-dec" title="Smaller text">A&minus;</button>
      <button class="fs-step chat-fs-inc" title="Larger text">A+</button>
      <button class="chat-dock" title="Anchor to right / float">&#9707;</button>
      <button class="chat-full" title="Fullscreen (Esc to exit)">&#9974;</button>
      <button class="chat-min" title="Minimize">–</button>
      <button class="chat-close" title="Close">&times;</button>
    </div>
    <div class="chat-body"></div>
    <div class="chat-input">
      <div class="chat-attach" hidden></div>
      <textarea placeholder="Message ${esc(AI)}…" rows="1"></textarea>
      <button class="chat-send">Send</button>
    </div>`;
  const bubble = el("div", { id: "chat-bubble", hidden: true });
  bubble.innerHTML = `
    <div class="bubble-head"><span class="bubble-who">${esc(AI)}</span><button class="bubble-x" title="Dismiss">&times;</button></div>
    <div class="bubble-text"></div>
    <div class="bubble-actions"><button class="bubble-open">Open chat</button></div>`;
  const ctx = el("div", { id: "chat-ctx", hidden: true });
  ctx.innerHTML = (HAS_RELAY ? `<button class="ctx-ask">Ask ${esc(AI)} about this</button>` : "") + `<button class="ctx-comment">Comment on this</button>`;
  const pill = el("div", { id: "chat-pill", hidden: true, role: "button", tabindex: "0", title: "Open chat (⌘J)" });
  pill.innerHTML = `<span class="pill-dot"></span><span class="pill-label">${esc(AI)}</span>`;
  document.addEventListener("DOMContentLoaded", mount);
  if (document.readyState !== "loading") mount();
  function mount() {
    if (ctx.isConnected) return;
    if (!HAS_RELAY) {
      document.body.append(ctx);
      wireContextMenu();
      for (const id of ["#chat-btn", "#mode-switch", "#listen-slot"]) {
        const node = document.querySelector(id);
        if (node) node.hidden = true;
      }
      return;
    }
    document.body.append(panel, bubble, ctx, pill);
    wire();
    wireContextMenu();
    restoreHistory();
    restorePosition();
    restorePillPosition();
    restoreDock();
    restoreFull();
    applyChatFs();
    persistFloatingSize();
    // Write mode is a split: the chat is open under the document unless it was
    // collapsed, at the height its divider was last dragged to.
    // Before the split, the bar started collapsed and that was saved, so most
    // browsers hold a "collapsed" from the old design. Reset it once.
    if (!load("vw_chat_split_v", false)) { save(LS.baropen, true); save("vw_chat_split_v", true); }
    if (load(LS.baropen, true)) document.body.classList.add("chat-bar-open");
    applySplit(load(LS.splith, null));
    if (load(LS.open, false)) { load(LS.min, false) ? minimizePanel() : showPanel(); }
    connect();
  }
  const inMode = () => document.body.classList.contains("mode-chat") || document.body.classList.contains("mode-writer");

  const dot = () => panel.querySelector(".chat-dot");
  const body = () => panel.querySelector(".chat-body");
  const ta = () => panel.querySelector(".chat-input textarea");
  const head = () => panel.querySelector(".chat-head");

  // --- SSE stream (auto-reconnect) ---
  let es = null;
  function connect() {
    try { es = new EventSource(STREAM); } catch { return; }
    es.onopen = () => dot().classList.add("live");
    es.onerror = () => { dot().classList.remove("live"); };
    es.onmessage = (ev) => {
      let text = ev.data;
      try { const j = JSON.parse(ev.data); if (j && typeof j.text === "string") text = j.text; } catch {}
      receive(text);
    };
  }

  // Turn bare URLs into real links. Built from text nodes and createElement,
  // never innerHTML — the message text is untrusted and this path must not
  // become an injection point just because we wanted clickable links.
  const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
  function appendLinked(parent, text) {
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      let href = match[0];
      // Trailing punctuation is almost always sentence punctuation, not URL.
      const trail = href.match(/[.,;:!?]+$/);
      if (trail) href = href.slice(0, -trail[0].length);
      const a = document.createElement("a");
      a.href = href;
      a.textContent = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.append(a);
      if (trail) parent.append(document.createTextNode(trail[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  // --- messaging ---
  const IMAGE_LINE = /^!\[\]\((api\/upload\/[0-9a-f]{20}\.(?:png|jpg|gif|webp))\)$/;
  // Text lines stay text; a line that is just an uploaded image shows the image.
  function appendBody(parent, text) {
    let run = [];
    const flush = () => { if (run.length) { appendLinked(parent, run.join("\n")); run = []; } };
    for (const line of text.split("\n")) {
      const m = IMAGE_LINE.exec(line);
      if (!m) { run.push(line); continue; }
      flush();
      const img = el("img", { class: "chat-img", src: m[1], alt: "" });
      img.addEventListener("load", () => { body().scrollTop = body().scrollHeight; });
      parent.append(img);
    }
    flush();
  }

  function appendMsg(role, text, quote, restoring) {
    const m = el("div", { class: "msg " + (role === "user" ? "user" : "rodin") });
    if (quote) { const q = el("span", { class: "quote" }); q.textContent = quote; m.append(q); }
    appendBody(m, text);
    body().append(m);
    body().scrollTop = body().scrollHeight;
    if (!restoring) {
      const h = load(LS.hist, []);
      h.push({ role, text, quote: quote || "" });
      save(LS.hist, h.slice(-HIST_CAP));
    }
  }

  function restoreHistory() {
    for (const m of load(LS.hist, [])) appendMsg(m.role, m.text, m.quote, true);
  }

  function receive(text) {
    appendMsg("rodin", text);
    // if the pane isn't showing its body, surface the reply as a bubble
    if (panel.hidden) { showBubble(text); pill.classList.add("alert"); }
    // the collapsed writer-mode bar shows no transcript, so mark its header
    else if (document.body.classList.contains("mode-writer") && !document.body.classList.contains("chat-bar-open")) head().classList.add("alert");
  }

  // Images waiting to go out with the next message: {url, path}. The url is what
  // the transcript shows; the path is what Rodin is told, so he can open the file.
  let attached = [];

  function renderAttached() {
    const strip = panel.querySelector(".chat-attach");
    strip.replaceChildren(...attached.map((a, i) => {
      const chip = el("span", { class: "chat-chip" });
      chip.append(el("img", { src: a.url, alt: "" }));
      const x = el("button", { title: "Remove" });
      x.textContent = "×";
      x.onclick = () => { attached.splice(i, 1); renderAttached(); };
      chip.append(x);
      return chip;
    }));
    strip.hidden = attached.length === 0;
  }

  async function attachFiles(files) {
    const { imageFiles, uploadImage } = await import("./images.js?v=adp1");
    for (const file of imageFiles(files)) {
      try { attached.push(await uploadImage(file)); renderAttached(); }
      catch (e) { appendMsg("rodin", "⚠️ " + e.message); }
    }
    ta().focus();
  }

  async function send(text, quote) {
    text = (text || "").trim();
    const images = attached; attached = []; renderAttached();
    if (!text && !images.length) return;
    const shown = [text, ...images.map((a) => `![](${a.url})`)].filter(Boolean).join("\n");
    const told = [text, ...images.map((a) => `[image attached, file on this box: ${a.path}]`)].filter(Boolean).join("\n");
    appendMsg("user", shown, quote);
    try {
      const r = await fetch(SEND, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: told, quote: quote || "" }),
      });
      if (!r.ok) appendMsg("rodin", `⚠️ couldn't send (${r.status})`);
    } catch (e) { appendMsg("rodin", "⚠️ send failed — is the relay up?"); }
  }

  // --- bubble (minimized reply) ---
  let bubbleTimer = null;
  function showBubble(text) {
    bubble.querySelector(".bubble-text").textContent = text;
    positionBubble();
    bubble.hidden = false;
  }
  function positionBubble() {
    // if the user has parked the bubble somewhere, honor it — future replies stick there
    const bp = load(LS.bubblepos, null);
    if (bp && Number.isFinite(bp.x) && Number.isFinite(bp.y)) {
      bubble.style.left = clamp(bp.x, 0, window.innerWidth - 60) + "px";
      bubble.style.top = clamp(bp.y, 0, window.innerHeight - 40) + "px";
      bubble.style.right = ""; bubble.style.bottom = "";
      return;
    }
    bubble.style.left = ""; bubble.style.top = "";
    if (!panel.hidden) {                       // panel open: hang under it
      const r = panel.getBoundingClientRect();
      bubble.style.right = (window.innerWidth - r.right) + "px";
      bubble.style.top = (r.bottom + 8) + "px"; bubble.style.bottom = "";
    } else if (!pill.hidden) {                  // minimized: sit just above the pill
      const r = pill.getBoundingClientRect();
      bubble.style.right = (window.innerWidth - r.right) + "px";
      bubble.style.bottom = (window.innerHeight - r.top + 8) + "px"; bubble.style.top = "";
    } else {                                     // closed: bottom-right
      bubble.style.right = "1.2rem"; bubble.style.bottom = "1.2rem"; bubble.style.top = "";
    }
  }

  // --- panel open/min/close + drag ---
  function scrollToBottom() { requestAnimationFrame(() => { body().scrollTop = body().scrollHeight; }); }
  // three states: shown (panel visible) · minimized (folded to the pill) · closed (nothing)
  function showPanel() {
    panel.hidden = false; pill.hidden = true;
    save(LS.open, true); save(LS.min, false);
    bubble.hidden = true; ta().focus(); scrollToBottom();
  }
  function minimizePanel() {
    panel.hidden = true; pill.hidden = false;
    pill.classList.toggle("live", !!(es && es.readyState === 1));
    save(LS.open, true); save(LS.min, true);
  }
  function closePanel() {
    panel.hidden = true; pill.hidden = true;
    save(LS.open, false); save(LS.min, false);
  }
  function toggle() {
    // a mode owns whether the panel is on screen; ⌘J then works the bar or the input instead
    if (inMode()) {
      // Write mode: ⌘J opens a collapsed split and goes to the input; it never collapses it
      if (document.body.classList.contains("mode-writer") && !document.body.classList.contains("chat-bar-open")) toggleBar();
      else ta().focus();
      return;
    }
    panel.hidden ? showPanel() : minimizePanel();
  }

  // The saved position came from whatever viewport it was dragged in. On a
  // narrower one it is clamped so the whole pane stays on screen, and nothing
  // is written: unfolding again gets the position he actually chose.
  let appliedSize = null;   // what restorePosition last set, so the observer can tell a clamp from a user resize
  function restorePosition() {
    const s = load(LS.size, null);
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
      panel.style.width = clamp(s.w, 240, window.innerWidth - 32) + "px";
      panel.style.height = clamp(s.h, 208, window.innerHeight - 32) + "px";
      appliedSize = { w: parseInt(panel.style.width, 10), h: parseInt(panel.style.height, 10) };
    }
    const p = load(LS.pos, null);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const { w, h } = floatingSize();
      panel.style.left = clamp(p.x, 0, Math.max(0, window.innerWidth - w)) + "px";
      panel.style.top = clamp(p.y, 0, Math.max(0, window.innerHeight - h)) + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    } else {
      panel.style.left = ""; panel.style.top = "";
      panel.style.right = "1.2rem"; panel.style.bottom = "1.2rem";
    }
  }

  // The pane's footprint once shown: its rendered size, or while hidden the
  // size it will render at (inline from the saved size, else the stylesheet's).
  function floatingSize() {
    if (panel.offsetWidth) return { w: panel.offsetWidth, h: panel.offsetHeight };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const w = Math.min(parseFloat(panel.style.width) || 22 * rem, window.innerWidth - 2 * rem);
    const h = Math.min(parseFloat(panel.style.height) || 28 * rem, window.innerHeight - 2 * rem);
    return { w, h };
  }

  const isFloating = () => !panel.hidden && !inMode()
    && !document.body.classList.contains("chat-docked") && !document.body.classList.contains("chat-full");

  // Persist size after a drag-resize. Installed once: restorePosition runs on
  // every return to floating, and an observer per call would multiply writes.
  // Skipped while minimized (height is auto), docked or in a layout mode, where
  // the size on screen is the column's or the mode's, not the floating pane's;
  // and skipped when the size is the one restorePosition just applied, which
  // on a narrow viewport is the saved size clamped, not a size he chose.
  function persistFloatingSize() {
    let szTimer = null;
    const userResized = () => isFloating()
      && !(appliedSize && appliedSize.w === panel.offsetWidth && appliedSize.h === panel.offsetHeight);
    new ResizeObserver(() => {
      if (!userResized()) return;
      clearTimeout(szTimer);
      // checked again when the debounce lands: a mode entered meanwhile would
      // otherwise have its dimensions written as the floating size
      szTimer = setTimeout(() => { if (userResized()) save(LS.size, { w: panel.offsetWidth, h: panel.offsetHeight }); }, 300);
    }).observe(panel);
  }

  function restorePillPosition() {
    const p = load(LS.pillpos, null);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      pill.style.left = clamp(p.x, 0, window.innerWidth - 40) + "px";
      pill.style.top = clamp(p.y, 0, window.innerHeight - 40) + "px";
      pill.style.right = "auto"; pill.style.bottom = "auto";
    }
  }

  // --- docked (anchored-right) mode ---
  // Floating and docked are orthogonal to shown/min/closed. Docked makes the
  // panel a right-hand flex column of <body> (full height); #main flexes to
  // fill the gap between sidebar and chat, so the editor reflows automatically.
  let lastDockW = null;
  function applyDockWidth() {
    const w = load(LS.dockw, null);
    if (Number.isFinite(w)) document.documentElement.style.setProperty("--chat-dock-w", Math.min(w, dockCeiling()) + "px");
  }
  const dockCeiling = () => Math.round(window.innerWidth * 0.6);
  function setDocked(on) {
    document.body.classList.toggle("chat-docked", on);
    save(LS.dock, on);
    if (on) {
      // hand layout control to CSS: clear the floating inline geometry so the
      // flex-basis var (not an inline width) drives the docked column size
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = "";
      panel.style.width = panel.style.height = "";
      applyDockWidth();
    } else {
      restorePosition();   // back to the last floating position + size
    }
    positionBubble();
  }
  function restoreDock() {
    applyDockWidth();
    if (load(LS.dock, false)) setDocked(true);
  }

  // --- fullscreen mode ---
  // A third geometry, independent of floating/docked: the CSS overrides both,
  // so leaving fullscreen drops back into whichever one was underneath without
  // having to remember it here. Opening the panel is implied — fullscreen on a
  // closed panel would otherwise do nothing visible.
  function setFull(on) {
    document.body.classList.toggle("chat-full", on);
    save(LS.full, on);
    if (on && panel.hidden) showPanel();
    positionBubble();
  }
  function restoreFull() {
    if (load(LS.full, false)) setFull(true);
  }

  // --- relayC layout modes ---
  // app.js owns which mode is active and persists it; this only applies the
  // body classes and keeps the panel in a state the mode can actually render.
  // Nothing here is saved, so leaving a mode drops back to the floating or
  // docked geometry that was already stored — same contract as setFull.
  let activeMode = "";
  let shownByMode = false;   // the mode unhid a closed/minimised panel; put it back on exit
  function setMode(mode) {
    const chat = mode === "chat", writer = mode === "writer";
    const next = chat ? "chat" : writer ? "writer" : "";
    if (next === activeMode) return;
    activeMode = next;
    document.body.classList.toggle("mode-chat", chat);
    document.body.classList.toggle("mode-writer", writer);
    head().classList.remove("alert");
    if (!chat && !writer) {
      document.body.classList.remove("chat-bar-open");
      if (shownByMode) { shownByMode = false; applyStoredVisibility(); }
      if (!document.body.classList.contains("chat-docked")) restorePosition();
      positionBubble();
      return;
    }
    // both modes render the panel itself, so a hidden or pill-minimised panel
    // would leave the mode showing nothing at all
    if (panel.hidden) { panel.hidden = false; pill.hidden = true; shownByMode = true; }
    // Floating leaves inline left/top/width on the element, and an inline style
    // beats the mode's stylesheet rules — so a mode entered from a floating
    // panel would render it offset over the editor's header. Hand layout back
    // to CSS, exactly as setDocked does. Nothing new is stored: leaving the
    // mode restores the floating geometry from where it was already saved.
    clearInlineGeometry();
    positionBubble();
  }

  // shown/minimised/closed as stored, without writing any of it
  function applyStoredVisibility() {
    const open = load(LS.open, false), min = load(LS.min, false);
    panel.hidden = !open || min;
    pill.hidden = !(open && min);
  }

  function clearInlineGeometry() {
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = "";
    panel.style.width = panel.style.height = "";
  }

  // --- Write-mode split: drag the divider above the chat to set its height ---
  const SPLIT_MIN = 120, splitCeiling = () => Math.round(window.innerHeight * 0.75);
  function applySplit(h) {
    if (Number.isFinite(h)) document.documentElement.style.setProperty("--chat-bar-open-h", clamp(h, SPLIT_MIN, splitCeiling()) + "px");
  }

  function toggleBar() {
    if (!document.body.classList.contains("mode-writer")) return;
    const open = document.body.classList.toggle("chat-bar-open");
    save(LS.baropen, open);
    if (open) { head().classList.remove("alert"); ta().focus(); scrollToBottom(); }
  }

  // --- chat text size (independent of the editor's) ---
  const CHAT_FS_MIN = 11, CHAT_FS_MAX = 22, CHAT_FS_DEF = 14;
  function applyChatFs() {
    const v = load(LS.chatfs, CHAT_FS_DEF);
    panel.style.setProperty("--chat-fs", (Number.isFinite(v) ? v : CHAT_FS_DEF) + "px");
  }
  function bumpChatFs(delta) {
    const cur = load(LS.chatfs, CHAT_FS_DEF);
    const next = Math.max(CHAT_FS_MIN, Math.min(CHAT_FS_MAX, (Number.isFinite(cur) ? cur : CHAT_FS_DEF) + delta));
    save(LS.chatfs, next); applyChatFs();
  }

  let pillMoved = false;   // set by a pill drag; suppresses the open-on-click that follows

  function wire() {
    const launcher = document.querySelector("#chat-btn");
    if (launcher) launcher.onclick = toggle;
    panel.querySelector(".chat-min").onclick = minimizePanel;
    panel.querySelector(".chat-close").onclick = closePanel;
    panel.querySelector(".chat-dock").onclick = () => setDocked(!document.body.classList.contains("chat-docked"));
    panel.querySelector(".chat-full").onclick = () => setFull(!document.body.classList.contains("chat-full"));
    panel.querySelector(".chat-head").addEventListener("click", (e) => {
      if (e.target.closest("button")) return;   // the header's own controls win
      if (document.body.classList.contains("mode-writer")) toggleBar();
    });
    // Escape leaves fullscreen, the convention everywhere else. Only when
    // fullscreen is actually on, so it doesn't swallow Escape from the editor.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("chat-full") && !inMode()
          && !document.body.classList.contains("writer-full")) {
        e.preventDefault();
        setFull(false);
      }
    });
    panel.querySelector(".chat-fs-dec").onclick = () => bumpChatFs(-1);
    panel.querySelector(".chat-fs-inc").onclick = () => bumpChatFs(+1);

    // dock resize: drag the left-edge grip (only visible when docked). Docked to
    // the right edge, so width grows as the pointer moves left.
    const grip = panel.querySelector(".chat-dock-grip");
    let gdrag = false;
    grip.addEventListener("pointerdown", (e) => { gdrag = true; document.body.classList.add("col-resizing"); e.preventDefault(); });
    window.addEventListener("pointermove", (e) => {
      if (!gdrag) return;
      lastDockW = clamp(window.innerWidth - e.clientX, 260, dockCeiling());
      document.documentElement.style.setProperty("--chat-dock-w", lastDockW + "px");
      positionBubble();
    });
    onRelease(() => {
      if (!gdrag) return;
      gdrag = false; document.body.classList.remove("col-resizing");
      if (Number.isFinite(lastDockW)) save(LS.dockw, lastDockW);
    });
    // Write-mode split divider: dragging up grows the chat, down grows the document.
    const split = panel.querySelector(".chat-split-grip");
    let sdrag = false, lastSplit = null;
    split.addEventListener("pointerdown", (e) => { sdrag = true; document.body.classList.add("row-resizing"); e.preventDefault(); e.stopPropagation(); });
    split.addEventListener("click", (e) => e.stopPropagation());   // a drag must not collapse the bar
    window.addEventListener("pointermove", (e) => {
      if (!sdrag) return;
      lastSplit = clamp(window.innerHeight - e.clientY, SPLIT_MIN, splitCeiling());
      applySplit(lastSplit);
    });
    onRelease(() => {
      if (!sdrag) return;
      sdrag = false; document.body.classList.remove("row-resizing");
      if (Number.isFinite(lastSplit)) save(LS.splith, lastSplit);
    });
    // click opens the chat; a drag repositions it (see the drag handler below)
    pill.onclick = () => { if (pillMoved) { pillMoved = false; return; } pill.classList.remove("alert"); showPanel(); };
    pill.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pill.classList.remove("alert"); showPanel(); } };
    panel.querySelector(".chat-send").onclick = () => { const v = ta().value; ta().value = ""; send(v); };
    ta().addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = ta().value; ta().value = ""; send(v); }
    });
    const input = panel.querySelector(".chat-input");
    ta().addEventListener("paste", (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); attachFiles(files); }
    });
    for (const target of [panel.querySelector(".chat-body"), input]) {
      target.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
      target.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); attachFiles(e.dataTransfer.files); }
      });
    }
    ta().addEventListener("input", () => { ta().style.height = "2.2rem"; ta().style.height = Math.min(ta().scrollHeight, 128) + "px"; });

    bubble.querySelector(".bubble-x").onclick = () => { bubble.hidden = true; };
    bubble.querySelector(".bubble-open").onclick = () => { pill.classList.remove("alert"); showPanel(); bubble.hidden = true; };

    // drag the reply bubble anywhere by its header; the spot sticks and every
    // future notification appears there (persisted, overriding the auto-anchor).
    const bhead = bubble.querySelector(".bubble-head");
    let bsx, bsy, box0, boy0, bdrag = false;
    bhead.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      bdrag = true; bubble.classList.add("dragging");
      const r = bubble.getBoundingClientRect();
      bsx = e.clientX; bsy = e.clientY; box0 = r.left; boy0 = r.top;
      bubble.style.left = box0 + "px"; bubble.style.top = boy0 + "px";
      bubble.style.right = ""; bubble.style.bottom = "";
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (!bdrag) return;
      bubble.style.left = clamp(box0 + e.clientX - bsx, 0, window.innerWidth - bubble.offsetWidth) + "px";
      bubble.style.top = clamp(boy0 + e.clientY - bsy, 0, window.innerHeight - 40) + "px";
    });
    onRelease(() => {
      if (!bdrag) return;
      bdrag = false; bubble.classList.remove("dragging");
      save(LS.bubblepos, { x: parseInt(bubble.style.left, 10), y: parseInt(bubble.style.top, 10) });
    });

    // drag by header
    const dragHandle = panel.querySelector(".chat-head");
    let sx, sy, ox, oy, dragging = false;
    dragHandle.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      if (document.body.classList.contains("chat-docked")) return;  // docked = no free-drag
      // A layout mode owns the panel's geometry, so free-dragging would both
      // write inline left/top the mode cannot honour and swallow the click the
      // writer-mode bar opens on (preventDefault below suppresses it).
      if (document.body.classList.contains("mode-chat")) return;
      if (document.body.classList.contains("mode-writer")) return;
      dragging = true; dragHandle.classList.add("dragging");
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.left = ox + "px"; panel.style.top = oy + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const x = clamp(ox + e.clientX - sx, 0, window.innerWidth - panel.offsetWidth);
      const y = clamp(oy + e.clientY - sy, 0, window.innerHeight - 40);
      panel.style.left = x + "px"; panel.style.top = y + "px";
    });
    onRelease(() => {
      if (!dragging) return;
      dragging = false; dragHandle.classList.remove("dragging");
      save(LS.pos, { x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) });
    });

    // drag the minimized pill to reposition it (the reply bubble follows it).
    // A small threshold distinguishes a drag from a plain click (which opens chat).
    let psx, psy, pox, poy, pdrag = false;
    pill.addEventListener("pointerdown", (e) => {
      pdrag = true; pillMoved = false;
      const r = pill.getBoundingClientRect();
      psx = e.clientX; psy = e.clientY; pox = r.left; poy = r.top;
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (!pdrag) return;
      if (!pillMoved && Math.abs(e.clientX - psx) + Math.abs(e.clientY - psy) < 4) return;
      pillMoved = true; pill.classList.add("dragging");
      pill.style.left = clamp(pox + e.clientX - psx, 0, window.innerWidth - pill.offsetWidth) + "px";
      pill.style.top = clamp(poy + e.clientY - psy, 0, window.innerHeight - pill.offsetHeight) + "px";
      pill.style.right = "auto"; pill.style.bottom = "auto";
      positionBubble();
    });
    onRelease(() => {
      if (!pdrag) return;
      pdrag = false; pill.classList.remove("dragging");
      if (pillMoved) save(LS.pillpos, { x: parseInt(pill.style.left, 10), y: parseInt(pill.style.top, 10) });
    });

    // A fold or unfold is a resize. Everything placed from saved pixels is
    // re-clamped to the new viewport; nothing is saved, so the old viewport's
    // choice comes back with it.
    window.addEventListener("resize", () => {
      if (isFloating()) restorePosition();
      restorePillPosition();
      if (document.body.classList.contains("chat-docked")) applyDockWidth();
      if (!bubble.hidden) positionBubble();
    });
  }

  // Right-click a selection in the editor: ask about it (with a relay) or
  // comment on it (always).
  function wireContextMenu() {
    // right-click a selection in the editor → ask about it
    const editor = document.querySelector("#editor");
    if (editor) {
      editor.addEventListener("contextmenu", (e) => {
        // CodeMirror is a contenteditable, so the selection lives in the window
        // selection (the old textarea .value/.selectionStart API is gone).
        const sel = ((window.getSelection && window.getSelection().toString()) || "").trim();
        if (!sel) return; // no selection → normal browser menu
        e.preventDefault();
        ctx.dataset.sel = sel;
        ctx.style.left = clamp(e.clientX, 0, window.innerWidth - 200) + "px";
        ctx.style.top = clamp(e.clientY, 0, window.innerHeight - 60) + "px";
        ctx.hidden = false;
      });
    }
    const ask = ctx.querySelector(".ctx-ask");
    if (ask) ask.onclick = () => {
      const sel = ctx.dataset.sel || "";
      ctx.hidden = true;
      send("What do you make of this?", sel);   // reply arrives via SSE; bubbles if pane hidden/min
      if (panel.hidden) showBubblePending();
    };
    ctx.querySelector(".ctx-comment").onclick = () => {
      ctx.hidden = true;
      if (window.vesselComments) window.vesselComments.compose();
    };
    document.addEventListener("click", (e) => { if (!ctx.contains(e.target)) ctx.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") ctx.hidden = true; });
  }

  // a drag ends on release, or when the browser takes the pointer away (a
  // touch that turned into a scroll, a finger that left the screen)
  function onRelease(fn) {
    window.addEventListener("pointerup", fn);
    window.addEventListener("pointercancel", fn);
  }

  function showBubblePending() {
    bubble.querySelector(".bubble-text").textContent = `Sent to ${AI}, waiting for a reply…`;
    positionBubble(); bubble.hidden = false;
  }

  // helpers
  function esc(text) { return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
  function el(tag, attrs) { const n = document.createElement(tag); for (const k in attrs) k === "hidden" ? (n.hidden = attrs[k]) : n.setAttribute(k, attrs[k]); return n; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ⌘J / Ctrl-J toggles the chat pane from anywhere
  document.addEventListener("keydown", (e) => {
    if (HAS_RELAY && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyJ") { e.preventDefault(); toggle(); }
  });

  window.vesselChat = HAS_RELAY
    ? { toggle, send, open: showPanel, minimize: minimizePanel, setMode }
    : { toggle() {}, send() {}, open() {}, minimize() {}, setMode() {} };
})();
