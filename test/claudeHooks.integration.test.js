import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createCortex } from "../src/index.js";

// Both tests below exercise the direct-DB fallback path (flushClaudeStop falls back only when
// the write client can't reach a server at all). Force CORTEX_PORT to a guaranteed-refused
// port so that's deterministic regardless of whether something happens to be listening on the
// real default port 4317 on the machine running this test.
const OFFLINE_ENV = { ...process.env, CORTEX_PORT: "1" };

test("Claude flush CLI emits capture result without blocking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-hook-cli-"));
  try {
    const dbPath = join(dir, "hook.sqlite");
    // flush is scoped to registered projects — seed the profile the spawned CLI will look up
    const seed = createCortex({ dbPath });
    seed.upsertProjectProfile({ projectPath: dir, name: "Test", mode: "general", summary: "" });
    seed.close();
    const cliPath = resolve("src/cli.js");
    const result = spawnSync(
      process.execPath,
      [cliPath, "--db", dbPath, "claude", "flush", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
        env: OFFLINE_ENV,
        input: JSON.stringify({
          hook_event_name: "Stop",
          cwd: dir,
          last_assistant_message: "Waiting for approval.",
        }),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "discarded_low_signal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory-file enrichment shares the durable capture fingerprint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-memory-hook-"));
  let hub;
  try {
    const dbPath = join(dir, "hook.sqlite");
    const seed = createCortex({ dbPath });
    seed.upsertProjectProfile({ projectPath: dir, name: "Test", mode: "general", summary: "" });
    seed.close();
    const scriptPath = resolve("src/flush-if-memory.js");
    const payload = {
      cwd: dir,
      last_assistant_message: "Fixed memory indexing. Verification: npm test passed.",
      tool_input: { file_path: join(dir, "memory", "decision.md") },
    };
    const first = spawnSync(process.execPath, [scriptPath], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify(payload),
      env: { ...OFFLINE_ENV, CORTEX_DB: dbPath, CORTEX_PROJECT: dir },
    });
    assert.equal(first.status, 0, first.stderr);

    hub = createCortex({ dbPath });
    const duplicate = hub.captureCandidate({
      projectPath: dir,
      agent: "claude-code",
      source: "claude-stop-hook",
      message: payload.last_assistant_message,
    });
    assert.equal(hub.storage.listFixes(dir).length, 1);
    assert.equal(duplicate.reason, "discarded_duplicate");
    hub.close();
    hub = undefined;
  } finally {
    hub?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
