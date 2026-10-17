// Driven by board_snapshot.py; not meant to be run by hand. Reads its job as
// JSON on stdin (so the token never appears in argv) and prints one JSON line.
import { createRequire } from "node:module";
const job = JSON.parse(await new Promise((ok) => { let s = ""; process.stdin.on("data", (d) => s += d); process.stdin.on("end", () => ok(s)); }));
const require = createRequire(job.playwrightDir + "/");
const { chromium } = require("playwright-core");
const origin = new URL(job.base).origin;
const browser = await chromium.launch({ executablePath: job.chromium, headless: true });
const shots = [];
try {
  for (const shot of job.shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.width, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    // the bearer goes only to the writer itself, never to anything else the page asks for
    await page.route("**/*", (route) => {
      const req = route.request();
      if (job.token && new URL(req.url()).origin === origin)
        return route.continue({ headers: { ...req.headers(), authorization: "Bearer " + job.token } });
      return route.continue();
    });
    const url = `${job.base}/board-render?path=${encodeURIComponent(job.path)}&board=${encodeURIComponent(job.board || "main")}&theme=${shot.theme}`;
    const res = await page.goto(url);
    if (!res || !res.ok()) throw new Error(`board-render answered ${res ? res.status() : "nothing"}`);
    await page.waitForFunction(() => window.__boardReady === true, null, { timeout: 15000 });
    await page.waitForTimeout(600);   // let the chalk fade-in finish
    const geometry = await page.evaluate(() => window.__boardGeometry);
    if (geometry && geometry.board !== (job.board || "main")) throw new Error(`drew board ${geometry.board}, not ${job.board}`);
    await page.screenshot({ path: shot.png, fullPage: true });
    shots.push({ width: shot.width, theme: shot.theme, png: shot.png, consoleErrors: errors, geometry });
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify({ shots }) + "\n");
