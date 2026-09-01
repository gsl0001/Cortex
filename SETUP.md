# Cortex — Setup & Operations

This covers everything beyond the [README](README.md) quickstart: the write
token, agent adapters, the MCP server, autonomy tiers, the evening brief,
notifications, deployment, and the full configuration reference.

## 1. Prerequisites

- **Node.js ≥ 25.** Cortex stores everything in SQLite via Node's built-in
  `node:sqlite` module, so there is no database server and no native build step.
  Check with `node --version`.

## 2. Install

```bash
git clone <your-fork-url> cortex
cd cortex
npm install
npm run web:build
```

## 3. The write token

Cortex refuses every write (`POST`/`PATCH`/`DELETE`) until `CORTEX_TOKEN` is set —
this is true even on localhost. Set one long random value once, machine-wide, so
the server, the hooks, and the MCP client all share it.

**macOS / Linux**

```bash
echo 'export CORTEX_TOKEN="your-long-random-string"' >> ~/.bashrc  # or ~/.zshrc
```

**Windows (PowerShell)**

```powershell
setx CORTEX_TOKEN "your-long-random-string"
```

`setx` does not affect the current shell — open a new terminal before `npm start`.

Generate a value with `openssl rand -hex 24` (or any password manager).

## 4. Run

```bash
npm start
```

Opens on `http://127.0.0.1:4317`. Override the bind with `CORTEX_HOST` /
`CORTEX_PORT`, and the database location with `CORTEX_DB` (default
`~/.cortex/cortex.sqlite`).

## 5. Agent adapters

### Claude Code

```bash
node src/cli.js claude install --project /path/to/your/project
```

This writes hooks into the project's `.claude/settings.local.json`:

- **SessionStart / prompt** → recalls compact, ranked project context.
- **Stop** → sends the session through the capture policy, keeping only durable
  fixes, research, blockers, and task transitions.

Uninstall by removing those hook entries from the file.

### Codex

Codex uses the same CLI and HTTP API — no separate hook file is installed because
Codex does not use Claude's hook schema. Point Codex at the CLI (`cortex …`) or
the HTTP API for recall and capture.

## 6. MCP server (mid-session recall)

Hooks handle session boundaries. For an agent to search or save memory *during* a
session, run `npm start` and register the MCP server in the project's `.mcp.json`
(see the [README](README.md#mid-session-recall-mcp)). Exposed tools:
`memory_search`, `memory_get`, `memory_remember`, `memory_recall_task`,
`memory_update_task`, `memory_lesson`. The session brief cites records by id
(`[m:42]`); `memory_get` fetches the full record on demand.

## 7. Autonomy tiers

Cortex never launches agents itself. Each project instead carries a tier —
`watch`, `plan`, `assist`, `auto`, lowest first — that says how much autonomy an
*external* orchestrator may take with it. Every project starts at `watch`.

- **Set a tier** from the web UI's Control Center, or
  `POST /api/v1/projects/tier` with `{ "projectPath": "...", "tier": "auto" }`.
- **Read tiers** from `GET /api/v1/projects` — each project row carries its
  `tier` and whether it is pinned.

### The pin (important)

Set `CORTEX_NEVER_AUTOPILOT` to a comma-separated list of absolute paths that an
autonomous agent must **never** run against — production repos, anything that
moves money, anything you don't want an agent touching:

```bash
export CORTEX_NEVER_AUTOPILOT="/path/to/prod-repo,/path/to/another"
```

Listed projects are pinned at `watch`: the API rejects any attempt to raise
them, and a batch tier write lands the rest of the batch while reporting the
pinned entries as rejected. Entries are normalized like project paths (resolve,
git root, case, separators), so a subdirectory or alternate spelling of a
protected repo still collapses onto the pin.

## 8. The evening brief

`node src/cli.js eod` builds a deterministic end-of-day report straight from
SQL — done work with evidence, a verify queue, blocked items, unresolved inbox
notes, and tonight's open tasks. Flags:

- `--html reports/eod/2026-08-31.html` — also render a standalone HTML page.
- `--notify` — push the summary to Telegram (see §9).
- `--digest` — one batched headless-`claude` call rewrites each item into plain
  English and adds a short "story of the day". Strictly additive: if the CLI is
  missing, auth expired, or the output is malformed, the SQL report stands
  untouched and the footer names the error.
- `--date 2026-08-30` / `--json` — pick a day, or emit machine-readable output.

[`scripts/eod-brief.ps1`](scripts/eod-brief.ps1) is a ready-made Windows Task
Scheduler wrapper; on macOS/Linux an equivalent cron line is
`45 17 * * * cd /path/to/cortex && node src/cli.js eod --notify --digest`.

## 9. Notifications (optional)

Cortex can push the evening brief and "needs you" events to Telegram. It reuses
the Claude Code Telegram channel config at `~/.claude/channels/telegram`
(`TELEGRAM_BOT_TOKEN` in `.env` plus the first allowlisted chat id). No config
present → notifications are simply disabled; everything else is unaffected.

## 10. Deployment

See the [Docker section in the README](README.md#deploy-with-docker). Key points:

- The container binds `0.0.0.0` and sets `CORTEX_ALLOW_REMOTE=1`, so it **requires**
  `CORTEX_TOKEN` at run time.
- The database lives on the `/data` volume — mount it so data survives restarts.
- If you expose Cortex beyond localhost, put it behind a reverse proxy with TLS.

## 11. Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_TOKEN` | *(none)* | **Required for writes.** Shared secret for all mutating requests. |
| `CORTEX_DB` | `~/.cortex/cortex.sqlite` | Database file path. |
| `CORTEX_HOST` | `127.0.0.1` | Bind address. |
| `CORTEX_PORT` | `4317` | Bind port. |
| `CORTEX_ALLOW_REMOTE` | `0` | Allow binding a non-loopback host (requires a token; reads become token-gated too). |
| `CORTEX_NEVER_AUTOPILOT` | *(empty)* | Comma-separated absolute paths pinned at the `watch` tier forever. |
| `CORTEX_EMBEDDINGS` | `0` | Set `1` to add a semantic arm to brief ranking (local Ollama embeddings). |
| `CORTEX_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint for embeddings. |
| `CORTEX_EMBED_MODEL` | `nomic-embed-text` | Embedding model name. |
| `CORTEX_TOPIC_SCOPE` | `1` | Set `0` to disable the off-topic brief filter. |
| `CORTEX_INBOX_TTL_DAYS`, `CORTEX_METRICS_RETENTION_DAYS`, `CORTEX_SESSION_TTL_HOURS`, … | various | Retention windows. |
| `CORTEX_BRIEF_TOKENS`, `CORTEX_BRIEF_SEMANTIC_WEIGHT`, `CORTEX_DEDUP_THRESHOLD`, `CORTEX_FIX_HALF_LIFE_DAYS`, … | various | Token budgets, ranking, and dedup tuning. |

The advanced knobs all have sensible defaults. For the complete list, grep the
source: `grep -rho "process.env.CORTEX_[A-Z_]*" src | sort -u`.

## 12. Back up & recover

Stop the server before copying the database:

```bash
cp ~/.cortex/cortex.sqlite ~/.cortex/cortex.backup.sqlite
```

Restore by replacing the file while the server is stopped, then run
`node src/cli.js index rebuild`. The audit (`node src/cli.js audit --all`) is
read-only and safe to run any time.

## 13. Verify your install

```bash
npm test
npm run web:test
npm run web:build
```

All three should pass on a clean checkout.
