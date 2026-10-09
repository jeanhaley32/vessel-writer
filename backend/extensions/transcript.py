#!/usr/bin/env python3
"""Turns the live Claude Code session transcript into a watchable activity feed.

Relayd's own stream carries only finished messages, so there is no data source
for "what is Rodin doing right now". The transcript on disk has it: thinking
blocks, every tool call, every result, written as they happen.

Two things this deliberately does NOT do. It never emits tool *results*, because
those carry whatever a command printed — vault reads, balances, credentials. And
it redacts anything secret-shaped out of the text it does emit. The feed is for
watching work happen, not for mirroring the session's full contents to a
browser.
"""
import json
import os
import re
import time

# Overridable so a test can point the tailer at a transcript it controls
# instead of the live session's.
def _default_project_dir():
    """Claude Code names a project's transcript folder after its directory, with
    the slashes turned into dashes."""
    relay_dir = os.path.expanduser("~/agent-relay")
    return os.path.expanduser("~/.claude/projects/" + relay_dir.replace("/", "-"))


PROJECT_DIR = os.path.expanduser(os.environ.get("ACTIVITY_PROJECT_DIR") or _default_project_dir())

SECRET_PATTERNS = [
    # Everything after a secret-shaped word goes, to the end of the line. The
    # narrower "keyword then one token" version let "the password is hunter2"
    # through, because it consumed the copula as the value and left the secret
    # in place. Over-redacting a sentence costs a reader some context; under-
    # redacting puts a credential in a browser.
    re.compile(r"(?i)\b(?:password|passwd|secret|token|api[_-]?key|bearer|credential)\b.*"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"),
    # A connection string carries its password in the URL: scheme://user:pass@host.
    re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/@:]+:[^\s@]+@[^\s]*"),
]
# Site-specific names worth hiding (a key file's path, say) come from the
# environment rather than this file: ACTIVITY_REDACT_EXTRA is one regex.
if os.environ.get("ACTIVITY_REDACT_EXTRA"):
    SECRET_PATTERNS.append(re.compile(os.environ["ACTIVITY_REDACT_EXTRA"]))

TOOL_SUMMARY_KEYS = ("command", "file_path", "pattern", "query", "url", "description")


def redact(text):
    for pat in SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text


def active_transcript():
    """The most recently written transcript in the project directory."""
    try:
        entries = [
            os.path.join(PROJECT_DIR, name)
            for name in os.listdir(PROJECT_DIR)
            if name.endswith(".jsonl")
        ]
    except OSError:
        return None
    if not entries:
        return None
    return max(entries, key=os.path.getmtime)


def summarise_tool(name, params):
    for key in TOOL_SUMMARY_KEYS:
        value = params.get(key)
        if isinstance(value, str) and value.strip():
            return redact(value.strip().splitlines()[0])[:240]
    return ""


def events_from(record):
    """Activity events for one transcript record, oldest field order preserved."""
    content = record.get("message", {}).get("content")
    if not isinstance(content, list):
        return []

    out = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "thinking":
            body = redact(block.get("thinking") or "").strip()
            if body:
                out.append({"kind": "thinking", "text": body})
        elif kind == "tool_use":
            params = block.get("input") or {}
            event = {
                "kind": "tool",
                "name": block.get("name") or "?",
                "text": summarise_tool(block.get("name") or "", params),
            }
            # A structured path, separate from the human summary, so a client
            # can offer to open the file without pattern-matching prose. Only
            # the parameter that genuinely names a file — not a command's
            # arguments, which are not paths and must not be guessed at.
            target = params.get("file_path")
            if isinstance(target, str) and target.strip():
                event["path"] = target.strip()
            out.append(event)
        elif kind == "text":
            body = redact(block.get("text") or "").strip()
            if body:
                out.append({"kind": "say", "text": body})
    return out


def follow(poll_seconds=0.6):
    """Yield activity events as they are appended. Starts at end of file."""
    path = active_transcript()
    handle = None
    while True:
        newest = active_transcript()
        if newest != path or handle is None:
            if handle:
                handle.close()
            path = newest
            if not path:
                time.sleep(poll_seconds)
                continue
            handle = open(path, "r", errors="replace")
            handle.seek(0, os.SEEK_END)

        line = handle.readline()
        if not line:
            time.sleep(poll_seconds)
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        for event in events_from(record):
            event["ts"] = time.strftime("%H:%M:%S")
            yield event
