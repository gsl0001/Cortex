# Cortex

**A local memory and autopilot layer for coding agents.**

Coding agents forget everything the moment a session ends. Cortex gives them a
memory that persists — and, if you want it, a way to keep working while you sleep.

It runs entirely on your machine: one Node process, one SQLite file, no external
services, no data leaving your laptop. It works with **Claude Code** and **Codex**
out of the box.

---

## What it does

**🧠 Memory that survives sessions.** As your agent finishes work, Cortex quietly
captures the things worth keeping — a fix and how it was verified, a research
finding, a blocker, a task that changed state. Generic "done!" chatter is thrown
away. What's left is deduplicated, linked to related records with typed
provenance, and ranked so the next session recalls the *relevant* past, not all
of it — packed to fit a token budget you control.

**🎛️ A command center.** A dark web dashboard that puts blocked work, unresolved
questions, and recent activity first. Search across projects with explained
scores, inspect the token pack, browse tasks and agent runs, run a database
audit, and explore an interactive graph of how your records connect.

**🤖 Autopilot (optional).** Enroll a project and Cortex can pick up its ready
tasks and run them autonomously — each in an isolated git worktree, with the
right model for the job (heavier reasoning for features and bugs, cheaper models
for chores), automatic review and verification, and a Telegram ping when
something needs you or a run fails. A hard safety guard refuses to ever launch an
agent against repos you mark off-limits.

---

## Quickstart

Requires **Node.js ≥ 25** (Cortex uses the built-in `node:sqlite` module — no
native build step, no database to install).

```bash
git clone <your-fork-url> cortex
cd cortex
npm install

# Set a write token (any long random string). Writes are refused until this exists.
export CORTEX_TOKEN="$(openssl rand -hex 24)"   # Windows: setx CORTEX_TOKEN "..." then open a new terminal

npm run web:build
npm start
```

Open **http://127.0.0.1:4317**. The server binds to loopback only and indexes
your records on startup.

---

## Connect your agent

### Claude Code

Install the hooks into any project you want remembered:

```bash
node src/cli.js claude install --project /path/to/your/project
```

From then on, Claude recalls compact project context at the start of a session
and Cortex captures durable takeaways when it stops — automatically.

### Mid-session recall (MCP)

Hooks cover session boundaries. To let an agent search or save memory *during* a
session, start the server (`npm start`) and register the MCP server in the
project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/absolute/path/to/cortex/src/mcp.js"],
      "env": {
        "CORTEX_URL": "http://127.0.0.1:4317",
        "CORTEX_TOKEN": "${CORTEX_TOKEN}",
        "CORTEX_AGENT": "claude-code"
      }
    }
  }
}
```

Use the **absolute path** to `src/mcp.js` in your Cortex checkout — your agent
launches this from your project's directory, not Cortex's.

Five tools are exposed: `memory_search`, `memory_remember`, `memory_recall_task`,
`memory_update_task`, `memory_lesson`.

Codex uses the same CLI and HTTP API.

---

## CLI

```bash
node src/cli.js search --project . --query "close fill" --max-tokens 1500
node src/cli.js brief --project .
node src/cli.js task add --project . --title "Fix login redirect" --type bug --priority high
node src/cli.js next-task --project . --claim --agent claude-code
node src/cli.js audit --all --json
node src/cli.js index rebuild
```

Search works with no embedding provider or API key. Its deterministic score
blends lexical relevance, typed graph proximity, record quality, and recency
decay — so verified older evidence can still outrank recent noise. Run
`node src/cli.js` with no arguments for the full command list.

---

## Deploy with Docker

```bash
docker build -t cortex .
docker run -d \
  -e CORTEX_TOKEN="your-long-random-token" \
  -p 4317:4317 \
  -v cortex-data:/data \
  cortex
```

The image builds the web UI, binds `0.0.0.0` (so port-mapping works), and stores
the database on the `/data` volume. Because it binds beyond loopback, the server
**requires** `CORTEX_TOKEN` and refuses to start without it. Put it behind a
reverse proxy with TLS if you expose it beyond localhost.

---

## Configuration

Only `CORTEX_TOKEN` is required. Everything else has a sensible default — see
[`.env.example`](.env.example) for the common knobs (`CORTEX_DB`, `CORTEX_HOST`,
`CORTEX_PORT`, `CORTEX_NEVER_AUTOPILOT`) and [`SETUP.md`](SETUP.md) for the full
setup, agent adapters, and Autopilot details.

## Security model

- **Loopback by default.** The server only binds a public interface when you opt
  in (`CORTEX_ALLOW_REMOTE=1`), and even then refuses to start without a token.
- **Writes are default-deny.** Every `POST`/`PATCH`/`DELETE` is rejected until
  `CORTEX_TOKEN` is set — even on localhost.
- **Autopilot is fenced.** Agents run in throwaway git worktrees, never your main
  checkout, and repos listed in `CORTEX_NEVER_AUTOPILOT` can never be launched.
- **Treat `CORTEX_TOKEN` like an SSH key.** Autopilot spawns coding agents and runs
  task verification commands automatically, so a leaked token means code execution
  on the host, not just read access. Keep the hub on loopback unless you front it
  with an authenticating reverse proxy over TLS.

## Development

```bash
npm test            # backend suite (node:test)
npm run web:test    # web UI tests (vitest)
npm run web:build   # production build
```

## Back up

Stop the server, copy the SQLite file, restart, and rebuild the index:

```bash
cp ~/.cortex/cortex.sqlite ~/.cortex/cortex.backup.sqlite
node src/cli.js index rebuild
```

## License

MIT — see [LICENSE](LICENSE).
