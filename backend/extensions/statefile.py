"""Small JSON state files for extensions whose state must outlive a restart.

A restart is not a decision the owner made. Twice now a deploy has silently
dropped his open comments and put him back in solitude while he was mid-draft,
and he reasonably read that as the feature being broken. So the state that
represents a choice he made gets written down.

Deliberately off the writing path: nothing here is called from on_save. Writes
are whole-file-then-rename so a crash mid-write leaves the previous state, and
every failure is logged and swallowed, because losing persistence is a far
smaller fault than failing the request that triggered it.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import siteconfig

log = logging.getLogger("vessel-writer.statefile")

STATE_DIR = siteconfig.STATE_DIR


def load(name: str, default):
    path = STATE_DIR / f"{name}.json"
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as exc:
        log.warning("state %s unreadable, starting empty (%s)", name, exc)
        return default


def save(name: str, value) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_DIR / f"{name}.json.tmp"
        tmp.write_text(json.dumps(value))
        os.replace(tmp, STATE_DIR / f"{name}.json")
    except (OSError, TypeError, ValueError) as exc:
        log.warning("state %s not written (%s)", name, exc)
