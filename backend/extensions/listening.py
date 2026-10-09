"""Active listening — relayC Phase 4, the writer side.

Two modes, and the server owns which one is in force. In solitude (the
default) a save is a save and nothing leaves this process. In listening, the
model is handed a diff of what the owner wrote, through relayd's loopback
inject webhook, so it can respond in his chat pane if it has something to say.
The text reaches the model, never a person; whether any of it is worth
surfacing is the model's call.

The core fires on_save only when a new 30s version slot opens, which is the
first save of a burst, carrying the first second of a paragraph. So on_save is
treated as the signal, not the send: it arms a settle timer, and when that
fires the document is read fresh and diffed against the last content that was
actually sent for that path. The settled paragraph goes out and nothing typed
between two sends is ever skipped, because the baseline is "last sent", not
"last version".

One timer, one send at a time, never closer than LISTEN_MIN_INTERVAL_S. A
burst across several documents coalesces into one inject. A send that cannot
be delivered keeps its baseline so the next one carries the gap, and is
counted and shown rather than retried on its own.

Nothing here runs on the save path except a dict insert and a timer arm under
a lock. The HTTP call happens on the timer thread with a short timeout, so a
relayd that is down, slow or refusing cannot delay or fail a save.

Config: LISTEN_INJECT_URL (relayd's inject webhook), LISTEN_CONV_ID (the admin
conversation the reply lands in; relayd refuses one it does not know),
LISTEN_SETTLE_S, LISTEN_MIN_INTERVAL_S, LISTEN_DIFF_CAP (chars per document).
"""
from __future__ import annotations

import difflib
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

from fastapi import APIRouter
from pydantic import BaseModel

from . import registry, statefile

log = logging.getLogger("vessel-writer.listening")

INJECT_URL = os.environ.get("LISTEN_INJECT_URL", "http://127.0.0.1:9210/webhook/inject")
CONV_ID = os.environ.get("LISTEN_CONV_ID", "web-jean")
SETTLE_S = float(os.environ.get("LISTEN_SETTLE_S", "3"))
MIN_INTERVAL_S = float(os.environ.get("LISTEN_MIN_INTERVAL_S", "10"))
DIFF_CAP = int(os.environ.get("LISTEN_DIFF_CAP", "6000"))
SOURCE = "vessel-writer listening"

router = APIRouter()

_lock = threading.Lock()
_STATE = "listening"
_restored = statefile.load(_STATE, {})
# The mode is the owner's choice, not the process's; a deploy must not silently
# put him back in solitude. The sent-baselines come back with it, so the first
# save after a restart diffs against what was really last sent rather than
# re-sending a whole document.
_listening = bool(_restored.get("listening", False))
_since: float | None = _restored.get("since") if _listening else None
_timer: threading.Timer | None = None
_pending: dict[str, str] = {}        # path -> content the next diff is taken against
_last_sent: dict[str, str] = _restored.get("last_sent", {}) if _listening else {}
_last_send_at = 0.0
_last_sent_wall: float | None = None   # wall-clock time of the last delivered diff, for the "Rodin is reading" indicator
_sent = 0
_failed = 0
_last_error: str | None = None
_vfs = None


class ModeBody(BaseModel):
    listening: bool


def status() -> dict:
    with _lock:
        return {
            "listening": _listening,
            "since": _since,
            "pending": len(_pending),
            "last_sent_at": _last_sent_wall,
            "sent": _sent,
            "failed": _failed,
            "last_error": _last_error,
            "conv_id": CONV_ID,
            "settle_s": SETTLE_S,
            "min_interval_s": MIN_INTERVAL_S,
        }


@router.get("/api/listening")
def get_listening():
    return status()


@router.put("/api/listening")
def put_listening(body: ModeBody):
    global _listening, _since, _timer, _last_error
    with _lock:
        if body.listening != _listening:
            _listening = body.listening
            _since = time.time() if _listening else None
            _last_error = None
            if not _listening:
                _cancel_timer_locked()
                _pending.clear()
                _last_sent.clear()
            _persist_locked()
    log.info("listening %s", "on" if body.listening else "off")
    return status()


def _persist_locked():
    statefile.save(_STATE, {"listening": _listening, "since": _since,
                            "last_sent": _last_sent})


def _cancel_timer_locked():
    global _timer
    if _timer is not None:
        _timer.cancel()
        _timer = None


def _previous_version_content(vfs, path: str) -> str:
    """The content before the version the save just opened; empty for a new doc."""
    versions = vfs.history(path)
    if len(versions) < 2:
        return ""
    return vfs.version_content(path, versions[1]["hash"]) or ""


def _on_save(vfs=None, path=None, **_):
    global _timer, _vfs
    if not path:
        return
    with _lock:
        if not _listening:
            return
        _vfs = vfs
        if path not in _pending:
            _pending[path] = _last_sent.get(path) if path in _last_sent \
                else _previous_version_content(vfs, path)
        if _timer is None:
            delay = max(SETTLE_S, _last_send_at + MIN_INTERVAL_S - time.monotonic())
            _timer = threading.Timer(delay, _flush)
            _timer.daemon = True
            _timer.start()


def _flush():
    global _timer, _last_send_at, _sent, _failed, _last_error, _last_sent_wall
    with _lock:
        _timer = None
        if not _listening or not _pending:
            _pending.clear()
            return
        batch = dict(_pending)
        _pending.clear()
        vfs = _vfs
    current = {path: ((vfs.read(path) or {}).get("content", "")) for path in batch}
    sections = [_section(path, before, current[path]) for path, before in batch.items()]
    sections = [s for s in sections if s]
    if not sections:
        with _lock:
            _last_sent.update(current)
            _persist_locked()
        return
    ok, error = _inject(_message(sections))
    with _lock:
        _last_send_at = time.monotonic()
        if ok:
            _sent += 1
            _last_sent_wall = time.time()
            _last_error = None
            _last_sent.update(current)
            _persist_locked()
        else:
            _failed += 1
            _last_error = error
            # keep the older baseline so the next send still covers this gap
            for path, before in batch.items():
                _pending.setdefault(path, before)


def _section(path: str, before: str, after: str) -> str | None:
    if before == after:
        return None
    lines = list(difflib.unified_diff(
        before.splitlines(), after.splitlines(), lineterm="", n=1,
        fromfile=f"{path} (before)", tofile=f"{path} (now)"))
    added = sum(1 for l in lines[2:] if l.startswith("+"))
    removed = sum(1 for l in lines[2:] if l.startswith("-"))
    body = "\n".join(lines[2:])
    if len(body) > DIFF_CAP:
        body = body[:DIFF_CAP] + f"\n… diff truncated at {DIFF_CAP} chars"
    return f"## {path}  (+{added} −{removed} lines)\n```diff\n{body}\n```"


def _message(sections: list[str]) -> str:
    head = ("Jean is writing in the vessel-writer with active listening on. "
            "This is what changed since the last time you saw the document. "
            "Reply in his writer chat only if you have something useful to say "
            "about the writing; saying nothing is a fine answer.")
    return head + "\n\n" + "\n\n".join(sections)


def _inject(text: str) -> tuple[bool, str | None]:
    payload = json.dumps({"text": text, "source": SOURCE, "conv_id": CONV_ID}).encode()
    req = urllib.request.Request(INJECT_URL, data=payload, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True, None
    except urllib.error.HTTPError as e:
        reason = {403: f"relay refused conv_id {CONV_ID!r} (403)",
                  503: "relay has no admin conversation (503)"}.get(
                      e.code, f"relay answered {e.code}")
        log.warning("listening inject failed: %s", reason)
        return False, reason
    except Exception as e:
        log.warning("listening inject unreachable: %s", e)
        return False, f"relay unreachable: {type(e).__name__}"


# on_change, not on_save: on_save fires once per 30s version slot (it feeds
# ingestion), so listening on it held edits for up to half a minute before the
# settle timer even started.
registry.on("on_change", _on_save)
registry.route(router)
