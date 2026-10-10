// Active listening indicator and switch (relayC Phase 4, feature 3.8).
// The server owns the mode; this module only asks it and shows the answer.
// Every render comes from a server response, never from a click, so a reload
// or a second tab cannot show a mode the server is not in. When the server
// cannot be asked the pill says "unknown" rather than guessing either way.
// Exposes window.vesselListening = { state, refresh, set }.
(() => {
  const POLL_MS = 15000;
  const CONFIG = window.vesselConfig || { assistant: "Assistant", relay: "" };
  const AI = CONFIG.assistant;
  const slot = document.getElementById("listen-slot");
  // Listening hands diffs to the assistant through the relay; with none, there
  // is nobody to listen.
  if (!slot || !CONFIG.relay) return;

  const btn = document.createElement("button");
  btn.id = "listen-toggle";
  btn.type = "button";
  btn.setAttribute("aria-pressed", "false");
  const dot = document.createElement("span");
  dot.className = "listen-dot";
  const label = document.createElement("span");
  label.className = "listen-label";
  btn.append(dot, label);
  slot.appendChild(btn);

  // Busy indicator, driven by the pipeline rather than by Rodin remembering to
  // toggle it: "queued" while the server holds your edits for the settle pause,
  // then a spinner from the moment a diff is delivered to Rodin until his turn
  // ends (the activity stream's next "says" event, which every turn produces,
  // reply or not). A 3-minute ceiling stops a lost end-of-turn from spinning forever.
  const busy = document.createElement("span");
  busy.id = "rodin-busy";
  busy.hidden = true;
  busy.setAttribute("role", "status");
  busy.setAttribute("aria-live", "polite");
  const spin = document.createElement("span");
  spin.className = "busy-spin";
  const busyLabel = document.createElement("span");
  busyLabel.className = "busy-label";
  busy.append(spin, busyLabel);
  slot.appendChild(busy);
  const BUSY_CEILING_MS = 180000;
  let lastSaidAt = 0;   // ms epoch of Rodin's latest "says" event
  let lastWorkAt = 0;   // ms epoch of his latest tool or thinking event

  function eventTime(ev) {
    // activity events carry a local HH:MM:SS; anchor it to today
    const m = /^(\d\d):(\d\d):(\d\d)$/.exec(ev && ev.ts || "");
    if (!m) return Date.now();
    const d = new Date(); d.setHours(+m[1], +m[2], +m[3], 0);
    return d.getTime() > Date.now() + 60000 ? d.getTime() - 86400000 : d.getTime();
  }
  window.addEventListener("rodin-activity", (e) => {
    if (!e.detail) return;
    const t = eventTime(e.detail);
    if (e.detail.kind === "say") lastSaidAt = Math.max(lastSaidAt, t);
    else lastWorkAt = Math.max(lastWorkAt, t);
    renderBusy();
  });

  function renderBusy() {
    const on = state && state.listening;
    const sentAt = on && state.last_sent_at ? state.last_sent_at * 1000 : 0;
    // still working: nothing said since the diff arrived, or tools ran after the last thing said
    const reading = sentAt && Date.now() - sentAt < BUSY_CEILING_MS
      && (lastSaidAt < sentAt || lastWorkAt > lastSaidAt);
    const queued = on && state.pending > 0;
    busy.dataset.state = reading ? "reading" : queued ? "queued" : "idle";
    busy.hidden = !reading && !queued;
    busyLabel.textContent = reading ? `${AI} is reading` : queued ? "queued" : "";
    busy.title = reading ? `Your latest edits reached ${AI}. This clears when the turn ends, reply or not.`
      : queued ? `Waiting for you to pause before sending your edits to ${AI}.` : "";
  }

  let state = null;   // the last server answer, or null while unknown

  function render(next) {
    state = next;
    if (!next) {
      btn.dataset.state = "unknown";
      btn.removeAttribute("data-error");
      btn.setAttribute("aria-pressed", "mixed");
      label.textContent = "Listening?";
      btn.title = `Could not reach the writer to ask whether ${AI} is listening.`;
      return;
    }
    const on = !!next.listening;
    btn.dataset.state = on ? "listening" : "solitude";
    btn.setAttribute("aria-pressed", String(on));
    if (on && next.last_error) btn.dataset.error = next.last_error; else btn.removeAttribute("data-error");
    label.textContent = on ? "Listening" : "Solitude";
    btn.title = on
      ? `${AI} is listening: saves go as diffs (${next.sent} sent` +
        (next.last_error ? `, last: ${next.last_error}` : "") + "). Click for solitude."
      : `Solitude: ${AI} sees nothing you write. Click to let it listen.`;
  }

  async function ask(method, body) {
    const res = await fetch("api/listening", {
      method, headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error("listening " + res.status);
    return res.json();
  }

  async function refresh() {
    try { render(await ask("GET")); } catch { render(null); }
    renderBusy();
    return state;
  }

  async function set(listening) {
    try { render(await ask("PUT", { listening })); } catch { render(null); }
    return state;
  }

  btn.addEventListener("click", () => {
    btn.disabled = true;
    set(!(state && state.listening)).finally(() => { btn.disabled = false; });
  });

  render(null);
  refresh();
  setInterval(refresh, POLL_MS);
  // the busy indicator needs a faster look than the mode pill: poll while
  // something is in flight, otherwise on every save the editor makes
  setInterval(() => { if (state && state.listening) refresh(); }, 2000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  window.vesselListening = { state: () => state, refresh, set };
})();
