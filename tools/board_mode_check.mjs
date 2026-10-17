// Headless check that board mode joins the writer without changing anything
// else. Runs one scenario against a baseline writer (the code before board
// mode) and a candidate, records layout and state at every step, and prints
// the differences, console errors, and board-mode results as JSON.
//
//   node tools/board_mode_check.mjs <playwright-core dir> <chromium> <baseline url> <candidate url>
// Both writers need WRITER_RELAY_CHAT=/relaychat; the relay is stubbed in the
// browser, so nothing reaches a real one.
import { createRequire } from "node:module";
const tap = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
const [pwDir, chromiumPath, baseUrl, candUrl] = process.argv.slice(2);
const { chromium } = createRequire(pwDir + "/")("playwright-core");

const STEPS = [
  ["write mode", async (p) => {}],
  ["chat bar toggled", async (p) => tap(p, "#chat-panel .chat-head .chat-title")],
  ["chat bar back", async (p) => tap(p, "#chat-panel .chat-head .chat-title")],
  ["chat mode", async (p) => tap(p, "#mode-switch .mode-toggle")],
  ["back to write", async (p) => tap(p, "#chat-panel .chat-to-write")],
  ["zen", async (p) => tap(p, "#toggle-side")],
  ["zen off", async (p) => tap(p, "#toggle-side")],
  ["fullscreen", async (p) => tap(p, "#full-btn")],
  ["fullscreen off", async (p) => tap(p, "#full-btn")],
  ["reading view", async (p) => tap(p, "#view-btn")],
  ["reading view off", async (p) => tap(p, "#view-btn")],
  ["history open", async (p) => tap(p, "#history-btn")],
  ["history closed", async (p) => p.keyboard.press("Escape").then(() => tap(p, "#path"))],
  ["appearance dark", async (p) => tap(p, "#appearance-btn").then(() => tap(p, '#appearance [data-value="dark"]'))],
];

const SELECTORS = ["#sidebar", "#main", "#editor", "#preview", "#chat-panel", "#chat-pill", "#history", "#appearance",
                   "#comments-btn", "#listen-slot", "#chat-btn", "#path", "#status"];

async function snapshot(page) {
  return page.evaluate((sels) => {
    const out = { classes: [...document.body.classList].filter((c) => c !== "mode-board").sort().join(" "),
                  storage: Object.fromEntries(Object.entries(localStorage).filter(([k]) => !k.startsWith("vw_chat_hist"))) };
    for (const s of sels) {
      const e = document.querySelector(s);
      if (!e) { out[s] = null; continue; }
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      out[s] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 display: cs.display, hidden: e.hidden };
    }
    return out;
  }, SELECTORS);
}

async function session(browser, url, width, extra) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/relaychat/**", (r) => r.request().url().endsWith("/stream")
    ? r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": stub\n\n" })
    : r.fulfill({ status: 200, body: "{}" }));
  await page.goto(url + "/");
  await page.waitForFunction(() => window.vesselWriter);
  await page.evaluate(() => window.vesselWriter.openDoc("notes/a.md"));
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(400);
  const states = [];
  for (const [name, act] of STEPS) {
    await act(page);
    await page.waitForTimeout(250);
    states.push([name, await snapshot(page)]);
  }
  const result = { states, errors };
  if (extra) result.board = await extra(page, errors);
  await ctx.close();
  return result;
}

async function boardScenario(page) {
  const r = {};
  await page.evaluate(() => { localStorage.setItem("vw_theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
  await tap(page, "#path");
  const before = await snapshot(page);
  r.litOnDocWithBoard = await page.evaluate(() => document.getElementById("board-btn").classList.contains("has-board"));
  await tap(page, "#board-btn");
  await page.waitForTimeout(500);
  r.inBoard = await page.evaluate(() => ({
    classes: document.body.className, pane: !document.getElementById("board-pane").hidden,
    toggleLabel: document.querySelector("#mode-switch .mode-toggle").textContent,
    nodes: document.querySelectorAll("#board-pane .bnode").length,
    pane_rect: document.getElementById("board-pane").getBoundingClientRect().toJSON(),
    main_rect: document.getElementById("main").getBoundingClientRect().toJSON(),
    geometry: window.__boardGeometry && window.__boardGeometry.summary }));
  // the editor still takes typing in board mode
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type(" typed in board mode");
  await page.waitForTimeout(2000);
  r.typedSaved = await page.evaluate(async () => (await (await fetch("api/doc?path=notes/a.md")).json()).content.includes("typed in board mode"));
  // a live append arrives over SSE
  await page.evaluate(() => fetch("api/board/append", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "notes/a.md", ops: [{ op: "node", id: "live", label: "drawn live", rank: 1 },
                                                    { op: "link", from: "x", to: "live", step: 1 }] }) }));
  await page.waitForTimeout(800);
  r.liveNodes = await page.evaluate(() => document.querySelectorAll("#board-pane .bnode").length);
  await page.evaluate(() => fetch("api/board/undo", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "notes/a.md" }) }));
  await page.waitForTimeout(800);
  r.afterUndoNodes = await page.evaluate(() => document.querySelectorAll("#board-pane .bnode").length);
  // switching documents switches boards
  await page.evaluate(() => window.vesselWriter.openDoc("ctf/demo.md"));
  await page.waitForTimeout(900);
  r.ctfNodes = await page.evaluate(() => document.querySelectorAll("#board-pane .bnode").length);
  r.ctfGeometry = await page.evaluate(() => window.__boardGeometry.summary);
  // chat bar works in board mode
  await tap(page, "#chat-panel .chat-head .chat-title");
  await page.waitForTimeout(250);
  r.chatBarToggles = await page.evaluate(() => document.body.classList.contains("chat-bar-open"));
  await tap(page, "#chat-panel .chat-head .chat-title");
  // leave board mode by the toggle, back on the first doc
  await tap(page, "#mode-switch .mode-toggle");
  await page.evaluate(() => window.vesselWriter.openDoc("notes/a.md"));
  await page.waitForTimeout(500);
  await tap(page, "#path");
  const after = await snapshot(page);
  r.leftBoard = await page.evaluate(() => ({ classes: document.body.className, pane: !document.getElementById("board-pane").hidden }));
  r.layoutRestored = diff(before, after, ["#status"]);
  r.persistedMode = await page.evaluate(() => localStorage.getItem("vw_mode"));
  return r;
}

function diff(a, b, ignore = []) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (ignore.includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ key: k, base: a[k], cand: b[k] });
  }
  return out;
}

const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const report = {};
try {
  for (const width of [1280, 390]) {
    const base = await session(browser, baseUrl, width);
    const cand = await session(browser, candUrl, width, width === 1280 ? boardScenario : null);
    report[width] = {
      baseErrors: base.errors, candErrors: cand.errors,
      differences: base.states.map(([name, s], i) => ({ step: name, diff: diff(s, cand.states[i][1], ["#status"]) }))
        .filter((d) => d.diff.length),
      board: cand.board,
    };
  }
} finally { await browser.close(); }
console.log(JSON.stringify(report, null, 1));
