// Headless check of named boards in the board pane: tabs, live ops landing on
// the right board whichever tab is showing, the remembered tab, "+", Clear and
// Delete on the active board, and a page whose localStorage throws. Prints one
// JSON report; "failures" lists every expectation that did not hold.
//
//   node tools/board_tabs_check.mjs <playwright-core dir> <chromium> <writer url> [old doc]
// Draws on tabs/net.md, so point it at a scratch writer, never the live one.
// [old doc] is a document whose board predates named boards; it must show as
// "main" alone. The relay is stubbed in the browser.
import { createRequire } from "node:module";
const [pwDir, chromiumPath, url, oldDoc] = process.argv.slice(2);
const { chromium } = createRequire(pwDir + "/")("playwright-core");
const DOC = "tabs/net.md";
const failures = [];
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push({ what, got, want });
};

async function api(method, path, body) {
  const res = await fetch(url + path, { method, headers: { "Content-Type": "application/json" },
                                        body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const node = (id, rank = 0, extra = {}) => ({ op: "node", id, label: id, rank, ...extra });

async function page(browser, width, init) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 } });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(String(e)));
  p.on("dialog", (d) => d.type() === "prompt" ? d.accept(p.answer || "") : d.accept());
  await p.route("**/relaychat/**", (r) => r.request().url().endsWith("/stream")
    ? r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": stub\n\n" })
    : r.fulfill({ status: 200, body: "{}" }));
  await p.goto(url + "/");
  await p.waitForFunction(() => window.vesselWriter && window.vesselBoard);
  return p;
}

async function openBoard(p, doc) {
  await p.evaluate((d) => window.vesselWriter.openDoc(d), doc);
  await p.waitForSelector(".cm-content");
  if (await p.evaluate(() => document.getElementById("board-pane").hidden))
    await p.evaluate(() => document.getElementById("board-btn").click());
  await p.waitForTimeout(700);
}

const state = (p) => p.evaluate(() => ({
  tabs: [...document.querySelectorAll("#board-pane .board-tab")].map((t) => t.dataset.board),
  active: document.querySelector("#board-pane .board-tab.active")?.dataset.board,
  unseen: [...document.querySelectorAll("#board-pane .board-tab.unseen")].map((t) => t.dataset.board),
  drawn: [...document.querySelectorAll("#board-pane .bnode")].map((n) => n.dataset.id),
  geometryBoard: window.__boardGeometry && window.__boardGeometry.board,
  problems: window.__boardGeometry ? Object.entries(window.__boardGeometry.summary)
    .filter(([k, v]) => k !== "nodes" && k !== "textCrossings" && v).map(([k]) => k) : null,
  deleteShown: !document.querySelector("#board-pane .board-delete").hidden,
  remembered: (() => { try { return localStorage.getItem("vw_board_tabs"); } catch { return "(throws)"; } })(),
  headFits: (() => {
    const pane = document.getElementById("board-pane").getBoundingClientRect();
    const clr = document.querySelector("#board-pane .board-clear").getBoundingClientRect();
    return clr.right <= pane.right + 0.5 && clr.width > 0;
  })(),
}));
const settle = (p) => p.waitForTimeout(700);
const tab = (p, name) => p.evaluate((n) => document.querySelector(`#board-pane .board-tab[data-board="${n}"]`).click(), name);

const report = { steps: {} };
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
try {
  await api("PUT", "/api/doc", { path: DOC, content: "# Network\n\nTwo boards on one document.\n" });
  for (const b of (await api("GET", `/api/board/list?path=${DOC}`)).body.boards)   // a rerun starts clean
    await api("POST", b.name === "main" ? "/api/board/clear" : "/api/board/delete", { path: DOC, board: b.name, confirm: true });
  await api("POST", "/api/board/append", { path: DOC, batch: "the network", ops: [
    { op: "zone", id: "lan", label: "LAN", kind: "segment" },
    node("router", 0, { kind: "service", zone: "lan", sub: "gateway" }), node("laptop", 1, { zone: "lan" }),
    node("nas", 1, { order: 1, kind: "state", zone: "lan" }),
    { op: "link", from: "laptop", to: "router", label: "dhcp" }, { op: "link", from: "nas", to: "router" }] });
  await api("POST", "/api/board/append", { path: DOC, board: "attack path", batch: "the chain", ops: [
    node("atk", 0, { kind: "actor", label: "attacker" }), node("web", 1, { kind: "service", label: "web app" }),
    { op: "link", from: "atk", to: "web", label: "phish", step: 1 }] });

  const p = await page(browser, 1280);
  await openBoard(p, DOC);
  let s = report.steps.opened = await state(p);
  expect("tabs on open", s.tabs, ["main", "attack path"]);
  expect("main shows first", [s.active, s.drawn], ["main", ["router", "laptop", "nas"]]);

  await api("POST", "/api/board/append", { path: DOC, board: "attack path", ops: [
    node("db", 2, { kind: "state", label: "customer db" }), { op: "link", from: "web", to: "db", label: "sqli", step: 2 }] });
  await settle(p);
  s = report.steps.liveOnHiddenTab = await state(p);
  expect("a live op on another tab leaves this one", s.drawn, ["router", "laptop", "nas"]);
  expect("the other tab is marked", s.unseen, ["attack path"]);

  await tab(p, "attack path");
  await settle(p);
  s = report.steps.switched = await state(p);
  expect("the hidden op was kept", s.drawn, ["atk", "web", "db"]);
  expect("geometry is of the active board", s.geometryBoard, "attack path");
  expect("no geometry problems", s.problems, []);
  expect("tab remembered", s.remembered, JSON.stringify({ [DOC]: "attack path" }));
  expect("delete offered on a named board", s.deleteShown, true);

  await api("POST", "/api/board/append", { path: DOC, ops: [node("printer", 1, { order: 2 })] });
  await settle(p);
  s = report.steps.liveOnMainWhileHidden = await state(p);
  expect("main's op did not land here", s.drawn, ["atk", "web", "db"]);
  await tab(p, "main");
  await settle(p);
  expect("main got its op", (await state(p)).drawn, ["router", "laptop", "nas", "printer"]);
  await tab(p, "attack path");

  await p.reload();
  await p.waitForFunction(() => window.vesselBoard);
  await openBoard(p, DOC);
  s = report.steps.reloaded = await state(p);
  expect("the remembered tab comes back", [s.active, s.drawn], ["attack path", ["atk", "web", "db"]]);

  p.answer = "  scratch  pad ";
  await p.evaluate(() => document.querySelector("#board-pane .board-add").click());
  await settle(p);
  s = report.steps.added = await state(p);
  expect("+ makes an empty active tab", [s.tabs, s.active, s.drawn], [["main", "attack path", "scratch pad"], "scratch pad", []]);
  expect("an undrawn board is not on the server", (await api("GET", `/api/board/list?path=${DOC}`)).body.boards.map((b) => b.name),
         ["main", "attack path"]);
  await api("POST", "/api/board/append", { path: DOC, board: "scratch pad", ops: [node("idea")] });
  await settle(p);
  expect("drawing on the new tab shows live", (await state(p)).drawn, ["idea"]);

  await p.evaluate(() => document.querySelector("#board-pane .board-clear").click());
  await settle(p);
  const counts = async () => Object.fromEntries((await api("GET", `/api/board/list?path=${DOC}`)).body.boards.map((b) => [b.name, b.count]));
  expect("Clear clears only the active board", await counts(), { main: 7, "attack path": 5, "scratch pad": 0 });
  await p.evaluate(() => document.querySelector("#board-pane .board-delete").click());
  await settle(p);
  s = report.steps.deleted = await state(p);
  expect("Delete takes the tab and falls back to main", [s.tabs, s.active], [["main", "attack path"], "main"]);
  expect("delete is hidden on main", s.deleteShown, false);
  expect("delete reached the server", Object.keys(await counts()), ["main", "attack path"]);
  report.errors1280 = p.errors;

  // a phone: the head fits, and storage that throws on the board's key breaks
  // nothing (the rest of the app needs storage, so only that key is broken)
  const phone = await page(browser, 390, () => {
    for (const fn of ["getItem", "setItem", "removeItem"]) {
      const real = Storage.prototype[fn];
      Storage.prototype[fn] = function (key, ...rest) {
        if (key === "vw_board_tabs") throw new Error("storage off");
        return real.call(this, key, ...rest);
      };
    }
  });
  await openBoard(phone, DOC);
  await tab(phone, "attack path");
  await settle(phone);
  s = report.steps.phoneNoStorage = await state(phone);
  expect("phone, no storage: tabs work", [s.active, s.drawn], ["attack path", ["atk", "web", "db"]]);
  expect("phone: Clear is still on the pane", s.headFits, true);
  expect("phone: no geometry problems", s.problems, []);
  report.errors390 = phone.errors.filter((e) => !e.includes("storage off"));

  if (oldDoc) {
    const o = await page(browser, 1280);
    await openBoard(o, oldDoc);
    s = report.steps.oldDoc = await state(o);
    expect("an old board is main, alone", s.tabs, ["main"]);
    if (!s.drawn.length) failures.push({ what: "the old board drew nothing" });
    expect("old board: no geometry problems", s.problems, []);
    report.errorsOld = o.errors;
  }
} finally { await browser.close(); }
for (const k of ["errors1280", "errors390", "errorsOld"]) if (report[k] && report[k].length) failures.push({ what: k, got: report[k] });
report.failures = failures;
console.log(JSON.stringify(report, null, 1));
process.exit(failures.length ? 1 : 0);
