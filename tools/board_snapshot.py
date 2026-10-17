#!/usr/bin/env python3
"""Render a document's board in a headless browser and report its geometry.

    WRITER_TOKEN_FILE=... python3 tools/board_snapshot.py --path learn/x.md [--board NAME] [--base URL] [--out DIR]

Loads /board-render for one board (main unless --board names another) at a phone width and a desktop width, in a light and a
dark theme, writes a PNG of each and prints one JSON object: the PNG paths
and, for each, the geometry the page measured (overlapping boxes, clipped
text, arrows through boxes, anything off the edge). Exits 1 when any shot has
a problem, so a script can gate on it; the JSON is printed either way.

The token comes from WRITER_TOKEN or the token file, is handed to the browser
driver on stdin, and is sent only to the writer's own origin. It is never put
in argv or printed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()
DEFAULT_PLAYWRIGHT = HOME / ".local/lib/playwright-mcp/node_modules"
WIDTHS = (390, 1280)
THEMES = ("light", "dark")


def token() -> str:
    value = os.environ.get("WRITER_TOKEN", "").strip()
    if value:
        return value
    path = Path(os.path.expanduser(os.environ.get("WRITER_TOKEN_FILE") or str(HOME / "vessel-writer/state/token")))
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def find_chromium() -> str:
    explicit = os.environ.get("BOARD_CHROMIUM")
    if explicit:
        return explicit
    cache = HOME / ".cache/ms-playwright"
    for pattern in ("chromium-*/chrome-linux64/chrome", "chromium-*/chrome-linux/chrome",
                    "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"):
        found = sorted(cache.glob(pattern))
        if found:
            return str(found[-1])
    for name in ("chromium-browser", "chromium", "google-chrome"):
        if shutil.which(name):
            return shutil.which(name)
    raise SystemExit("board_snapshot: no chromium found; set BOARD_CHROMIUM")


def problems(geometry: dict) -> int:
    s = geometry.get("summary", {})
    return sum(s.get(k, 0) for k in ("overlaps", "clipped", "linkCrossings", "tagOverlaps", "outside"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--path", required=True, help="document whose board to render")
    ap.add_argument("--board", default="main", help="which of the document's boards (default main)")
    ap.add_argument("--base", default=os.environ.get("WRITER_BASE", "http://127.0.0.1:8791"))
    ap.add_argument("--out", help="directory for the PNGs (default: a new temp dir)")
    ap.add_argument("--widths", default=",".join(map(str, WIDTHS)))
    ap.add_argument("--themes", default=",".join(THEMES))
    args = ap.parse_args(argv)

    out = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="board-snapshot-"))
    out.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.path).strip("_") or "board"
    if args.board != "main":
        stem += "--" + re.sub(r"[^A-Za-z0-9_-]+", "_", args.board)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    shots = [{"width": int(w), "theme": t, "png": str(out / f"{stem}-{w}-{t}-{stamp}.png")}
             for w in args.widths.split(",") for t in args.themes.split(",")]
    job = {"base": args.base.rstrip("/"), "path": args.path, "board": args.board, "token": token(), "shots": shots,
           "chromium": find_chromium(),
           "playwrightDir": os.environ.get("BOARD_PLAYWRIGHT_DIR", str(DEFAULT_PLAYWRIGHT))}
    proc = subprocess.run(["node", str(HERE / "board_snapshot.mjs")], input=json.dumps(job),
                          capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        print(json.dumps({"error": proc.stderr.strip()[-2000:] or f"driver exited {proc.returncode}"}))
        return 2
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    result["path"] = args.path
    result["board"] = args.board
    result["problems"] = sum(problems(s["geometry"]) + len(s["consoleErrors"]) for s in result["shots"])
    print(json.dumps(result))
    return 1 if result["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
