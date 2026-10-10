# vessel-writer

A self-hosted, distraction-free markdown writer for one person, built so that an
AI collaborator can read along, comment on the draft, talk about it, and write
into it like a co-author, without ever being able to overwrite it.

It was built for a personal home lab, where the collaborator is a Claude Code
session reached through a small relay. The writer stands on its own: everything
under "Writing" works with no AI parts at all, and each assistant feature is
optional and off unless configured.

## Writing

- **Editor.** CodeMirror 6 with markdown highlighting, a reading view that
  renders markdown and mermaid diagrams, themes, typefaces, and adjustable text
  size. No build step and no CDN: every browser dependency is vendored.
- **Live co-editing.** Every tab on a document joins one server-side Yjs session,
  so two windows (or a phone and a laptop) edit the same text with live cursors.
  A script that saves through the API is merged in as an edit instead of
  overwriting what the tabs hold.
- **History.** Every document keeps a version every 30 seconds of work, up to 12
  hours of it. Any version can be viewed and restored, and restoring is itself an
  undoable edit.
- **Files.** Folders, drag-to-move, rename in place, and a delete that can be
  undone. `POST /api/reap` purges what has stayed deleted past a grace
  period (seven days by default); run it from a timer.
- **Images.** Paste or drop a screenshot into a document or the chat. Images are
  stored once, named by the hash of their bytes. Only PNG, JPEG, GIF and WebP are
  accepted; SVG is refused because it can carry script.

## The collaborator (optional)

- **Inline comments.** The assistant anchors comments to exact quoted spans. Each
  comment opens a thread you can reply in, and you can start threads of your own
  on selected text. Comments are additive and dismissible, and dismissing one
  archives it rather than deleting it.
- **Anchored edits.** The assistant writes into a document the way a co-author
  would: insert after or before a quoted passage, replace a quoted span, or
  append (`POST /api/doc/edit`). Each anchor is found in the live text at the
  moment the edit applies, so only that span changes, an open tab sees it
  arrive with the assistant's cursor, and nothing typed elsewhere is lost. A
  missing or ambiguous anchor refuses the whole request, and no edit can
  replace a whole document.
- **Who wrote what.** Text the assistant wrote is tinted in the editor, and
  active listening never reports the assistant's own edits back to it.
  Attribution comes from Yjs: every edit that is not a tab's is made by the
  server session's own client. It lasts as long as the live session; after a
  restart the document reloads untinted.
- **Chat pane.** A dockable, resizable chat with the assistant, alongside or under
  the document. It talks to a relay at `/relaychat/` (SSE + POST). The relay is a
  separate service and not part of this repository; without one, the pane stays
  offline.
- **Active listening.** A switch the owner controls. In *solitude*, the default,
  nothing you write leaves the process. In *listening*, the assistant is sent a
  diff of each settled paragraph through a relay webhook, and replies in chat
  only if it has something useful to say.
- **Activity rail.** A live, structured view of what the assistant is doing:
  the tools it calls and what it says, read from a Claude Code session
  transcript on the same machine. Tool *results* are never sent to the browser,
  and anything secret-shaped is redacted. Off unless `ACTIVITY_ENABLED=1`.
- **writer-mcp.** A stdio MCP server, so an agent can read documents and work
  with comments through tools instead of hand-written HTTP calls. See below.

## Recall (optional)

With a Postgres DSN configured, every new version is chunked, embedded with a
local Ollama model, and stored in Qdrant, so past writing is searchable by
meaning. Re-embedding is incremental: only paragraphs that changed are embedded
again. Deletes, moves and purges follow through to both stores.

## How it stores things

Every saved version is an immutable blob named by the SHA-256 of its content
(gzip at rest). That makes change detection, version history and deduplication
free. Folders, paths and names are metadata in a SQLite index that maps a path to
its current blob, so a rename touches no content. Everything lives under
`$WRITER_ROOT` (`blobs/`, `index.sqlite`, and a `manifest.json` of path to hash),
so the corpus can be read and backed up without the app running.

```
backend/
  app.py            FastAPI app: pages, document API, live co-editing sessions
  auth.py           owner-token authentication
  vfs.py            the virtual filesystem over the blobs (SQLite + manifest)
  blobstore.py      content-addressed blob store
  extensions/       features that hook in rather than edit the core:
    ingestion.py      Postgres + Qdrant recall
    comments.py       inline comments and threads
    listening.py      active listening
    activity.py       activity rail (with transcript.py)
    uploads.py        pasted images
    resources.py      the launcher page's list
static/             the browser app, no build step
cmd/writer-mcp/     the MCP adapter (Go)
tests/              storage and auth tests
```

Extensions register hook callbacks (`on_save`, `on_change`, `on_delete`,
`on_move`, ...) and their own routers. A failing hook is logged and never fails
a save, and an extension route that collides with a core route can never be
served.

## Running it

Needs Python 3.10+, plus Go 1.25+ for the MCP adapter.

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh            # http://127.0.0.1:8791
```

Documents live in `$WRITER_ROOT` (default `~/vessel-log/writing`). To reach it
from other devices, put it behind a reverse proxy you control and **set a
token first** (see below). It was built to sit behind a Tailscale-only nginx;
any private network works the same way.

## Authentication

There is one owner and one token. Auth is off until a token exists, so a
loopback-only install behaves as before.

- Set `WRITER_TOKEN`, or write the token to `WRITER_TOKEN_FILE` (default
  `~/vessel-writer/state/token`, mode 600). The file is read on every request,
  so writing it takes effect without a restart.
- A browser logs in once on a password form, which phone password managers can
  fill. It gets an HttpOnly, SameSite=Strict cookie for 90 days. The cookie holds
  an HMAC of the token, never the token, so changing the token signs every
  device out.
- Scripts and `writer-mcp` send `Authorization: Bearer <token>`.
- `POST /api/login-link` (authorised) returns a one-time `login?code=...` path,
  valid for five minutes, for signing in a phone without typing the token.
- Loopback is not trusted. Behind a reverse proxy, every request comes from
  127.0.0.1.
- With no token, the app refuses to start on any host but loopback
  (`WRITER_HOST`, which `run.sh` passes to uvicorn).

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `WRITER_ROOT` | `~/vessel-log/writing` | documents, blobs, index |
| `WRITER_STATE_DIR` | `~/vessel-writer/state` | comments, listening mode, uploads, the launcher list |
| `WRITER_HOST` / `WRITER_PORT` | `127.0.0.1` / `8791` | bind address (`run.sh`) |
| `WRITER_TOKEN` / `WRITER_TOKEN_FILE` | unset / `<state>/token` | owner token; auth is off without one |
| `WRITER_CLIENTLOG` | `~/vessel-writer/client.log` | browser errors, capped at 2 MB |
| `INGEST_PG_DSN` | unset | enables recall ingestion |
| `INGEST_QDRANT_URL`, `INGEST_OLLAMA_URL`, `INGEST_COLLECTION`, `INGEST_EMBED_MODEL` | loopback defaults, `vessel_writing`, `nomic-embed-text` | recall backends |
| `LISTEN_INJECT_URL`, `LISTEN_CONV_ID` | relay loopback webhook | where listening diffs and comment replies are sent |
| `LISTEN_SETTLE_S`, `LISTEN_MIN_INTERVAL_S`, `LISTEN_DIFF_CAP` | `3`, `10`, `6000` | listening cadence |
| `ACTIVITY_ENABLED` | off | `1` turns on the activity rail |
| `ACTIVITY_PROJECT_DIR` | derived from `~/agent-relay` | the Claude Code project whose transcript the rail reads |
| `RESOURCES_FILE` | `<state>/resources.json`, else the starter list | the launcher page's list |

Keep secrets such as the Postgres DSN in an environment file outside the
repository. The systemd unit used here loads `ingestion.env`, which is
gitignored.

## writer-mcp

`cmd/writer-mcp` is a stdio MCP server that turns tool calls into HTTP requests
to the writer. Build it with `go build -o bin/writer-mcp ./cmd/writer-mcp` and
register it with your MCP client. Pass `-base` for the writer's URL and
`-token-file` (or `WRITER_TOKEN`) when auth is on.

It has eight tools: `doc_read`, `doc_list`, `doc_edit`, `comment_post`,
`comment_list`, `comment_resolve`, `listening_get`, `listening_set`.

**There is deliberately no `doc_write`.** Documents are the owner's prose. The
assistant writes into a draft through comments and through `doc_edit`, whose
edits are anchored to quoted text and change only that span. A test asserts
that no registered tool can save, replace or delete a whole document, so this
boundary cannot erode by accident. A non-2xx response, an
unreachable writer and a wrong-shaped body each come back as an error, never as
an empty result.

## Tests

```
.venv/bin/python -m unittest discover -s tests   # storage + auth (auth starts a real server)
go test ./cmd/writer-mcp/
python3 tools/smoke_writer_mcp.py <doc-path>     # MCP end to end against a running writer
```

The browser suites, which drive real Chromium through every feature, live
outside this repository with the author's test harness.

## License

MIT, see [LICENSE](LICENSE). Vendored browser libraries keep their own MIT
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
