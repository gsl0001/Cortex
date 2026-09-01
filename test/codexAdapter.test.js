import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex, createClaudeHookContext } from "../src/index.js";
import { lastCodexAgentMessage, findCodexTranscript, flushCodexStop } from "../src/codexAdapter.js";

// no server reachable in tests -> deterministic fallback to direct DB write
const offlineClient = { capture: async () => { throw new Error("server unreachable"); } };
// the server WAS reached and rejected the write — mirrors writeClient.js's post() throw
const rejectingClient = { capture: async () => {
  const error = new Error("message is required");
  error.isHttpRejection = true;
  error.status = 400;
  throw error;
} };

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-codex-"));
  const hub = createCortex({ dbPath: join(dir, "c.sqlite") });
  // recall/flush are scoped to registered projects — unregistered dirs get a stub and no capture
  hub.upsertProjectProfile({ projectPath: dir, name: "Test Project", mode: "general", summary: "" });
  try { await fn({ dir, hub }); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

const ROLLOUT = [
  JSON.stringify({ type: "session_meta", payload: { id: "sid-1", cwd: "C:/proj" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier note" }] } }),
  JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Fixed the retry backoff. Verification: npm test passed" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed the retry backoff. Verification: npm test passed" } }),
].join("\n");

test("lastCodexAgentMessage prefers the final agent message", async () => {
  await withProject(async ({ dir }) => {
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, ROLLOUT);
    assert.match(lastCodexAgentMessage(file), /Fixed the retry backoff/);
    assert.equal(lastCodexAgentMessage(""), "");
    assert.equal(lastCodexAgentMessage(join(dir, "missing.jsonl")), "");
  });
});

test("findCodexTranscript locates the rollout by session id in nested dirs", async () => {
  await withProject(async ({ dir }) => {
    const nested = join(dir, "2026", "06", "21");
    await mkdir(nested, { recursive: true });
    const file = join(nested, "rollout-2026-06-21T21-17-48-sid-1.jsonl");
    await writeFile(file, ROLLOUT);
    assert.equal(findCodexTranscript("sid-1", dir), file);
    assert.equal(findCodexTranscript("nope", dir), null);
    assert.equal(findCodexTranscript("", dir), null);
  });
});

test("flushCodexStop captures the final message through the shared gate", async () => {
  await withProject(async ({ dir, hub }) => {
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, ROLLOUT);
    const accepted = await flushCodexStop(hub, { hook_event_name: "Stop", cwd: dir, transcript_path: file }, { client: offlineClient });
    assert.equal(accepted.reason, "accepted_fix");
    assert.match(hub.buildBrief({ projectPath: dir, context: { goalText: "retry backoff" } }).text, /retry backoff/);

    // empty/unknown session -> nothing captured, no throw
    const empty = await flushCodexStop(hub, { hook_event_name: "Stop", cwd: dir, session_id: "does-not-exist" }, { client: offlineClient });
    assert.equal(empty.reason, "discarded_empty");
  });
});

test("duplicate Codex SessionStart ids open once and Stop closes the root session", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart",
      cwd: dir,
      session_id: "codex-sess-1",
      agent_type: "codex",
      branch: "feat/x",
    });
    let active = hub.storage.listActiveSessions(dir);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "codex-sess-1");
    assert.equal(active[0].agent, "codex");
    assert.equal(active[0].source, "codex-session-hook");
    assert.match(hub.buildBrief({ projectPath: dir, context: { branch: "feat/x" } }).text, /Active Agent Sessions[\s\S]*codex/);

    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart",
      cwd: dir,
      session_id: "codex-worker-1",
      agent_type: "codex",
    });
    assert.equal(hub.storage.listActiveSessions(dir).length, 1);

    // A worker Stop must not close the root session it did not open.
    await flushCodexStop(hub, {
      hook_event_name: "Stop", cwd: dir, session_id: "codex-worker-1", recentFiles: ["src/x.js"],
    }, { client: offlineClient });
    assert.equal(hub.storage.listActiveSessions(dir).length, 1);

    await flushCodexStop(hub, {
      hook_event_name: "Stop", cwd: dir, session_id: "codex-sess-1", recentFiles: ["src/x.js"],
    }, { client: offlineClient });
    active = hub.storage.listActiveSessions(dir);
    assert.equal(active.length, 0);
    assert.equal(hub.storage.getSession("codex-sess-1").status, "finished");
  });
});

test("flush stores a truncated outcome on the finished Codex session", async () => {
  await withProject(async ({ dir, hub }) => {
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, ROLLOUT);
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "codex-out-1", agent_type: "codex",
    });
    await flushCodexStop(hub, {
      hook_event_name: "Stop", cwd: dir, session_id: "codex-out-1", transcript_path: file,
    }, { client: offlineClient });
    const session = hub.storage.getSession("codex-out-1");
    assert.equal(session.status, "finished");
    assert.match(session.outcome, /Fixed the retry backoff/);
    assert.equal(session.outcome.length <= 240, true);
  });
});

test("capture routes through the HTTP client first; no direct write when it succeeds", async () => {
  await withProject(async ({ dir, hub }) => {
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, ROLLOUT);
    const calls = [];
    const client = { capture: async (candidate) => { calls.push(candidate); return { action: "captured", reason: "accepted_fix" }; } };
    const result = await flushCodexStop(hub, { hook_event_name: "Stop", cwd: dir, transcript_path: file }, { client });
    assert.equal(result.reason, "accepted_fix");
    assert.equal(calls.length, 1);
    assert.match(calls[0].message, /retry backoff/);
    assert.equal(calls[0].source, "codex-stop-hook");
    // the capture went over HTTP — the local DB must not have a second copy
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /retry backoff/);
  });
});

test("an HTTP rejection does not fall back to a direct DB write", async () => {
  await withProject(async ({ dir, hub }) => {
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, ROLLOUT);
    const result = await flushCodexStop(hub, { hook_event_name: "Stop", cwd: dir, transcript_path: file }, { client: rejectingClient });
    assert.equal(result.action, "rejected");
    assert.equal(result.reason, "server_rejected");
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /retry backoff/);
  });
});
