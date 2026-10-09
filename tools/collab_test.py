"""Live co-editing check: two browser tabs and an external writer edit one
document at once, then the server restarts. Run against a throwaway server:

    T=/tmp/wtest WRITER_ROOT=$T/root ... uvicorn ... --port 8891   (see restart.sh in $T)
    T=/tmp/wtest python tools/collab_test.py

Needs playwright and a Chromium (CHROME env var, else Playwright's own)."""
import json, os, time, urllib.request, sys
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:8891/"
PATH = "doc.md"

def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

def server_text():
    return req("GET", "api/doc?collab=1&path=" + PATH)[1]["content"]

def blob_text():
    return req("GET", "api/doc?path=" + PATH)[1]["content"]

def tab_text(p):
    return p.evaluate("""() => Array.from(document.querySelectorAll('.cm-line')).map(l => {
        const c = l.cloneNode(true); c.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo').forEach(e => e.remove());
        return c.textContent; }).join('\\n')""").rstrip("\n")

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name, ("" if cond else detail))

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=os.environ.get("CHROME") or None)
    a = b.new_page(); a.goto(BASE); a.wait_for_selector(".cm-content"); time.sleep(1.5)
    c = b.new_page(); c.goto(BASE); c.wait_for_selector(".cm-content"); time.sleep(1.5)
    errs = []
    for p in (a, c): p.on("pageerror", lambda e: errs.append(str(e)))
    check("both tabs open same text", tab_text(a) == tab_text(c) == server_text().rstrip("\n"), (tab_text(a), tab_text(c)))

    # Tab A types at the end of line one
    a.click(".cm-line >> nth=0", force=True); a.keyboard.press("End"); a.keyboard.type(" [A]")
    time.sleep(1.5)
    check("A's edit reaches tab C", "[A]" in tab_text(c), tab_text(c))

    # Rodin writes externally while tabs are open
    cur = server_text()
    st, _ = req("PUT", "api/doc", {"path": PATH, "content": cur.replace("beta", "BETA (Rodin)"), "external": True})
    time.sleep(1.5)
    check("external write accepted", st == 200, st)
    check("external edit shows in both tabs", "BETA (Rodin)" in tab_text(a) and "BETA (Rodin)" in tab_text(c), (tab_text(a), tab_text(c)))
    check("A's edit survived the external write", "[A]" in tab_text(a) and "[A]" in server_text())

    # simultaneous: C types on line two while Rodin appends a line and A types on line one
    c.click(".cm-line >> nth=1", force=True); c.keyboard.press("End"); c.keyboard.type(" [C]")
    cur = server_text()
    req("PUT", "api/doc", {"path": PATH, "content": cur + "Rodin line\n", "external": True})
    a.click(".cm-line >> nth=0", force=True); a.keyboard.press("Home"); a.keyboard.type("[A2] ")
    time.sleep(3)  # let autosaves (1.2s debounce) settle
    st_ = server_text()
    check("all three concurrent edits present", all(x in st_ for x in ("[A2]", "[C]", "Rodin line", "[A]", "BETA (Rodin)")), st_)
    check("no duplicated text", st_.count("Line one") == 1 and st_.count("Rodin line") == 1 and st_.count("[A]") == 1, st_)
    check("tabs converge with server", tab_text(a) == tab_text(c) == st_.rstrip("\n"), (tab_text(a), tab_text(c), st_))
    time.sleep(1.5)
    check("saved file matches live text", blob_text() == st_, (blob_text(), st_))

    # a stale tab write (no collab, no external) is refused
    st, body = req("PUT", "api/doc", {"path": PATH, "content": "stale overwrite"})
    check("legacy/stale save refused with 409", st == 409, (st, body))
    check("refused save changed nothing", server_text() == st_)

    # a fresh tab opened now joins the session without splicing
    d = b.new_page(); d.goto(BASE); d.wait_for_selector(".cm-content"); time.sleep(1.5)
    check("late-joining tab sees exact text", tab_text(d) == st_.rstrip("\n"), (tab_text(d), st_))
    d.click(".cm-line >> nth=0", force=True); d.keyboard.press("End"); d.keyboard.type(" [D]")
    time.sleep(1.5)
    check("late tab edit reaches others", "[D]" in tab_text(a) and "[D]" in tab_text(c))

    # server restart: sessions vanish; tabs must rejoin without losing or doubling text
    import subprocess, os
    before = server_text()
    subprocess.run([os.environ["T"] + "/restart.sh"])
    time.sleep(6)   # EventSource reconnects, sees a new session id, rejoins
    after = server_text()
    check("text intact across restart", after.rstrip("\n") == before.rstrip("\n"), (before, after))
    a.click(".cm-line >> nth=0", force=True); a.keyboard.press("End"); a.keyboard.type(" [after]")
    for i in range(20):
        time.sleep(1)
        if "[after]" in tab_text(c): break
    print("C caught up after", i + 1, "s")
    st2 = server_text()
    check("edits work after restart", "[after]" in st2 and "[after]" in tab_text(c), (st2, tab_text(c)))
    check("no doubling after restart", st2.count("Line one") == 1, st2)
    check("no page errors", not errs, errs)
    b.close()
print("SUMMARY", sum(ok for _, ok in results), "/", len(results))
