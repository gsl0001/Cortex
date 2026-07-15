# Cortex — Setup & Operations

This covers everything beyond the [README](README.md) quickstart: the write
token, agent adapters, the MCP server, Autopilot, notifications, deployment, and
the full configuration reference.

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
`memory_search`, `memory_remember`, `memory_recall_task`, `memory_update_task`,
`memory_lesson`.

## 7. Autopilot

Autopilot lets Cortex run a project's ready tasks autonomously.

- **Enroll** a project from the web UI's Control Center (or the `/api/v1/dispatcher`
  endpoint). Enrollment is per-project and reversible.
- Each task runs in an **isolated git worktree**, never your main checkout.
- **Model routing** picks a heavier model for features/bugs/research and a cheaper
  one for chores/docs/tests. Override per project via the `modelRouting` setting.
- Runs are **reviewed and verified** before completion; failures are classified.

### Safety guard (important)

Set `CORTEX_NEVER_AUTOPILOT` to a comma-separated list of absolute paths that an
agent must **never** be launched against — production repos, anything that moves
money, anything you don't want an autonomous agent touching:

```bash
export CORTEX_NEVER_AUTOPILOT="/path/to/prod-repo,/path/to/another"
```

The guard fires at the launch chokepoint itself, so both the dispatcher and a
direct launch request are blocked. Enrollment of a listed repo is silently
filtered out.

## 8. Notifications (optional)

For overnight runs, Cortex can push "run failed" and "needs you" events to
Telegram. It reuses the Claude Code Telegram channel config at
`~/.claude/channels/telegram` (`TELEGRAM_BOT_TOKEN` in `.env` plus the first
allowlisted chat id). No config present → notifications are simply disabled; the
run pipeline is unaffected.

## 9. Deployment

See the [Docker section in the README](README.md#deploy-with-docker). Key points:

- The container binds `0.0.0.0` and sets `CORTEX_ALLOW_REMOTE=1`, so it **requires**
  `CORTEX_TOKEN` at run time.
- The database lives on the `/data` volume — mount it so data survives restarts.
- If you expose Cortex beyond localhost, put it behind a reverse proxy with TLS.

## 10. Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_TOKEN` | *(none)* | **Required for writes.** Shared secret for all mutating requests. |
| `CORTEX_DB` | `~/.cortex/cortex.sqlite` | Database file path. |
| `CORTEX_HOST` | `127.0.0.1` | Bind address. |
| `CORTEX_PORT` | `4317` | Bind port. |
| `CORTEX_ALLOW_REMOTE` | `0` | Allow binding a non-loopback host (requires a token). |
| `CORTEX_NEVER_AUTOPILOT` | *(empty)* | Comma-separated absolute paths agents must never run against. |
| `CORTEX_INBOX_TTL_DAYS`, `CORTEX_METRICS_RETENTION_DAYS`, `CORTEX_SESSION_TTL_HOURS`, … | various | Retention windows. |
| `CORTEX_BRIEF_TOKENS`, `CORTEX_DEDUP_THRESHOLD`, `CORTEX_AGENT_TIMEOUT_MIN`, … | various | Token budgets, dedup, and agent-run tuning. |

The advanced knobs all have sensible defaults. For the complete list, grep the
source: `grep -rho "process.env.CORTEX_[A-Z_]*" src | sort -u`.

## 11. Back up & recover

Stop the server before copying the database:

```bash
cp ~/.cortex/cortex.sqlite ~/.cortex/cortex.backup.sqlite
```

Restore by replacing the file while the server is stopped, then run
`node src/cli.js index rebuild`. The audit (`node src/cli.js audit --all`) is
read-only and safe to run any time.

## 12. Verify your install

```bash
npm test
npm run web:test
npm run web:build
```

All three should pass on a clean checkout.
