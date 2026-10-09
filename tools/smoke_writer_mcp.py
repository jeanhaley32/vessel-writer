#!/usr/bin/env python3
"""Smoke-test writer-mcp end to end over real stdio against the live writer.

The unit tests cover the translation layer with a fake server. This proves the
other half: that the binary speaks MCP correctly over a pipe and that a tool
call reaches the running writer and comes back with real content. A piped
heredoc cannot do this — stdin closes before the server answers — so the
harness holds the pipe open and reads replies as they arrive.

Usage: python3 tools/smoke_writer_mcp.py [doc-path]
"""
import json
import subprocess
import sys

BIN = "./bin/writer-mcp"
BASE = "http://127.0.0.1:8791"


def main(doc=None):
    p = subprocess.Popen([BIN, "-base", BASE], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def send(msg):
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()

    def read_id(want):
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("id") == want:
                return msg
        raise SystemExit(f"no reply to id={want}; the server closed first")

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                     "clientInfo": {"name": "smoke", "version": "0"}}})
    info = read_id(1)["result"]["serverInfo"]
    print(f"initialize: {info['name']} {info['version']}")

    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    names = [t["name"] for t in read_id(2)["result"]["tools"]]
    print(f"tools ({len(names)}): {', '.join(names)}")

    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
          "params": {"name": "doc_list", "arguments": {}}})
    print("doc_list:", "ok" if "result" in read_id(3) else "FAILED")

    if doc:
        send({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
              "params": {"name": "doc_read", "arguments": {"path": doc}}})
        r = read_id(4)
        if r.get("result", {}).get("isError"):
            print(f"doc_read {doc}: FAILED {r['result']}")
        else:
            body = json.loads(r["result"]["content"][0]["text"])
            print(f"doc_read {doc}: {len(body.get('content',''))} chars")

    # A missing document must come back as a tool error, never as empty content.
    send({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
          "params": {"name": "doc_read", "arguments": {"path": "does/not/exist.md"}}})
    r = read_id(5)
    errored = r.get("result", {}).get("isError") or "error" in r
    print("missing doc fails loudly:", "yes" if errored else "NO — this is the bug this command exists to prevent")

    p.stdin.close()
    p.wait(timeout=5)
    return 0 if errored else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
