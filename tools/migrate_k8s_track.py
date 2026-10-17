#!/usr/bin/env python3
"""Move the /k8s-track/ prototype into the writer as its first board doc.

    WRITER_TOKEN_FILE=... python3 tools/migrate_k8s_track.py --base http://127.0.0.1:8795

Writes learn/k8s-control-plane-s1.md from the prototype's state.json (the
lesson steps as sections, the glossary as a terms list, and the session's
dialogue), then imports board.json's ops as that document's board in one
batch. --base has no default, so it can never run against the live writer by
accident. It refuses to touch a document or board that already exists.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DOC = "learn/k8s-control-plane-s1.md"
SPEAKERS = {"prof": "Professor", "jean": "Jean"}


def token() -> str:
    value = os.environ.get("WRITER_TOKEN", "").strip()
    if value:
        return value
    path = Path(os.path.expanduser(os.environ.get("WRITER_TOKEN_FILE") or "~/vessel-writer/state/token"))
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def call(base, method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if token():
        headers["Authorization"] = "Bearer " + token()
    req = urllib.request.Request(base + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def document(state: dict) -> str:
    out = [f"# {state['session']} · {state['title']}", ""]
    for step in state.get("steps", []):
        out += [f"## {step['id']}. {step['heading']}", "", step["body"], ""]
    if state.get("glossary"):
        out += ["## Terms", ""]
        out += [f"- **{g['k']}**: {g['v']}" for g in state["glossary"]]
        out.append("")
    turns = [t for t in state.get("dialogue", []) if (t.get("text") or "").strip()]
    if turns:
        out += ["## The session", ""]
        for t in turns:
            out += [f"**{SPEAKERS.get(t.get('who'), t.get('who', '?'))}:** {t['text'].strip()}", ""]
    return "\n".join(out).rstrip() + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", required=True, help="the writer to write into")
    ap.add_argument("--source", default="/var/www/k8s-track")
    args = ap.parse_args(argv)
    base, src = args.base.rstrip("/"), Path(args.source)
    state = json.loads((src / "state.json").read_text())
    ops = json.loads((src / "board.json").read_text())["ops"]

    status, _ = call(base, "GET", "/api/doc?path=" + urllib.parse.quote(DOC))
    if status != 404:
        print(f"{DOC} already exists (or the writer answered {status}); not touching it", file=sys.stderr)
        return 1
    status, board = call(base, "GET", "/api/board?path=" + urllib.parse.quote(DOC))
    if status != 200 or board["ops"]:
        print(f"{DOC} already has a board (or the writer answered {status}); not touching it", file=sys.stderr)
        return 1
    status, body = call(base, "POST", "/api/board/append", {"path": DOC, "ops": ops, "batch": "from /k8s-track/"})
    if status != 200:
        print(f"the board was refused, nothing written: {body}", file=sys.stderr)
        return 1
    status, saved = call(base, "PUT", "/api/doc", {"path": DOC, "content": document(state), "author": "assistant"})
    if status != 200:
        print(f"the document was refused ({status}): {saved}; the board was imported as batch {body['batch']}",
              file=sys.stderr)
        return 1
    print(json.dumps({"doc": DOC, "hash": saved["hash"], "board_batch": body["batch"], "ops": len(body["seqs"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
