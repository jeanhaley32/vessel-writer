// The activity rail — what Rodin is doing, pinned at the sidebar's bottom.
//
// One source feeds it: the structured event stream at api/activity/stream,
// which never carries tool results. There is deliberately no raw terminal
// view in the writer; the terminal lives at `tmux attach` or ttyd, where
// command output stays off a browser page's history, cache and screenshots.
//
// Nothing here may interfere with writing: every entry point is wrapped, and a
// rail that fails to start leaves the editor untouched.
(function () {
  "use strict";

  var MAX_ROWS = 300;          // a long session must not grow the DOM without bound
  var SEEN_CAP = 800;          // dedupe memory, comfortably above the server's replay backlog
  var RECONNECT_MS = 2000;
  var RECONNECT_MAX_MS = 30000;
  var STREAM_URL = "api/activity/stream";

  var KIND_LABEL = { thinking: "thinks", tool: "tool", say: "says" };
  var OPEN_KEY = "vw_rail_open";
  var HEIGHT_KEY = "vw_rail_h";
  var HEIGHT_VAR = "--rail-h";

  function id(name) { return document.getElementById(name); }

  function remembered(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) { return fallback; }
  }

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private window */ }
  }

  var box = id("rail");
  if (!box) return;

  var head = box.querySelector(".rail-head");
  var live = id("rail-live");
  var feed = id("rail-feed");
  var modal = id("rail-modal");
  var modalSlot = id("rail-modal-slot");
  var grip = id("rail-grip");
  var status = id("rail-status");

  var open = remembered(OPEN_KEY, "false") === "true";
  var seen = Object.create(null);
  var seenOrder = [];
  var source = null;
  var retryTimer = null;
  var retryDelay = RECONNECT_MS;

  // --- the box's three states: collapsed line, expanded feed, fullscreen ---

  function isFull() { return !!modal && modal.classList.contains("open"); }

  function applyState() {
    box.dataset.state = open ? "open" : "collapsed";
    if (head) head.setAttribute("aria-expanded", String(open));
  }

  function setOpen(next) {
    open = !!next;
    remember(OPEN_KEY, String(open));
    applyState();
    stick();
  }

  // The expanded body moves into the modal rather than being mirrored, so there
  // is only ever one feed holding one set of rows.
  function setFull(next) {
    if (!modal || !modalSlot) return;
    if (next) {
      modalSlot.appendChild(feed);
      modal.classList.add("open");
    } else {
      box.appendChild(feed);
      modal.classList.remove("open");
    }
    stick();
  }

  // --- rendering ---

  function nearBottom(node) {
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  function stick() {
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  function oneLine(text) {
    var first = String(text || "").split("\n")[0].trim();
    return first.length > 160 ? first.slice(0, 160) + "…" : first;
  }

  function showLive(event) {
    if (!live) return;
    live.dataset.kind = event.kind;
    live.textContent = event.kind === "tool" && event.name
      ? event.name + " · " + oneLine(event.text)
      : oneLine(event.text);
  }

  function addRow(event) {
    if (!feed) return;
    var row = document.createElement("div");
    row.className = "rail-row";
    row.dataset.kind = event.kind;

    var tag = document.createElement("span");
    tag.className = "rail-tag";
    tag.textContent = event.kind === "tool" && event.name
      ? event.name
      : (KIND_LABEL[event.kind] || event.kind);

    var text = document.createElement("span");
    text.className = "rail-text";
    text.textContent = event.text || "";

    var when = document.createElement("time");
    when.className = "rail-when";
    when.textContent = event.ts || "";

    row.appendChild(tag);
    row.appendChild(text);
    row.appendChild(when);

    var follow = nearBottom(feed);
    feed.appendChild(row);
    while (feed.childElementCount > MAX_ROWS) feed.removeChild(feed.firstElementChild);
    if (follow) feed.scrollTop = feed.scrollHeight;
  }

  // A reconnecting EventSource is replayed the server's recent backlog, so the
  // same events arrive twice. Key on what the event says rather than on
  // position in the stream, which a reconnect does not preserve.
  function fresh(event) {
    var key = [event.ts, event.kind, event.name || "", event.text || ""].join("\u0000");
    if (seen[key]) return false;
    seen[key] = true;
    seenOrder.push(key);
    while (seenOrder.length > SEEN_CAP) delete seen[seenOrder.shift()];
    return true;
  }

  function onEvent(event) {
    if (!event || typeof event.kind !== "string") return;
    if (!fresh(event)) return;
    showLive(event);
    addRow(event);
    // let other parts of the page (the busy indicator) follow Rodin's activity
    try { window.dispatchEvent(new CustomEvent("rodin-activity", { detail: event })); } catch (e) { /* old browser */ }
  }

  // --- the stream ---

  function setStatus(state) {
    box.dataset.conn = state;
    if (status) status.textContent = state === "live" ? "live" : state;
  }

  function close() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (source) {
      try { source.close(); } catch (e) { /* already gone */ }
      source = null;
    }
  }

  function connect() {
    close();
    try {
      source = new EventSource(STREAM_URL);
    } catch (e) {
      setStatus("offline");
      return;
    }
    setStatus("connecting");
    source.onopen = function () { retryDelay = RECONNECT_MS; setStatus("live"); };
    source.onmessage = function (message) {
      retryDelay = RECONNECT_MS;
      setStatus("live");
      try {
        onEvent(JSON.parse(message.data));
      } catch (e) { /* one malformed frame must not kill the rail */ }
    };
    // EventSource retries on its own, but not once it has given up (CLOSED),
    // which is where a dropped stream silently stays dead.
    source.onerror = function () {
      setStatus("reconnecting");
      if (!source || source.readyState !== 2) return;
      close();
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
    };
  }

  // --- controls ---

  function wire() {
    if (head) {
      // Expanding the rail must never take focus from the editor.
      head.addEventListener("mousedown", function (e) { e.preventDefault(); });
      head.addEventListener("click", function (e) {
        if (e.target.closest("[data-rail-action]")) return;
        setOpen(!open);
      });
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); }
      });
    }

    var expand = box.querySelector("[data-rail-action='full']");
    if (expand) expand.addEventListener("click", function (e) {
      e.stopPropagation();
      setFull(!isFull());
    });

    var closeBtn = id("rail-close");
    if (closeBtn) closeBtn.addEventListener("click", function () { setFull(false); });

    // Not while the writer is fullscreen: the overlay is off screen under it,
    // and that Escape belongs to leaving fullscreen, after which it returns.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isFull() && !document.body.classList.contains("writer-full")) setFull(false);
    });

    if (grip) {
      var dragging = false;
      grip.addEventListener("pointerdown", function (e) {
        dragging = true;
        document.body.classList.add("row-resizing");
        if (!open) setOpen(true);
        e.preventDefault();
      });
      window.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var ceiling = Math.round(window.innerHeight * 0.7);
        var h = Math.max(60, Math.min(window.innerHeight - e.clientY - 40, ceiling));
        document.documentElement.style.setProperty(HEIGHT_VAR, h + "px");
      });
      var release = function () {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove("row-resizing");
        var h = parseInt(document.documentElement.style.getPropertyValue(HEIGHT_VAR), 10);
        if (Number.isFinite(h)) remember(HEIGHT_KEY, h);
      };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
    }
  }

  function start() {
    var savedHeight = parseInt(remembered(HEIGHT_KEY, ""), 10);
    if (Number.isFinite(savedHeight))
      document.documentElement.style.setProperty(HEIGHT_VAR, savedHeight + "px");
    applyState();
    wire();
    setStatus("connecting");
    connect();
  }

  try {
    start();
  } catch (e) {
    // The rail is not the act of writing. If it cannot start, it stays quiet.
    box.dataset.conn = "offline";
  }

  window.vesselRail = {
    isOpen: function () { return open; },
    isFull: isFull,
    setOpen: setOpen,
    setFull: setFull,
    rows: function () { return feed ? feed.childElementCount : 0; },
  };
})();
