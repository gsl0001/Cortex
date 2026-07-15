import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-capture-"));
  const hub = createCortex({ dbPath: join(dir, "capture.sqlite") });
  try {
    await fn(hub, dir);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("discards empty, generic completion, approval, and question messages", async () => {
  await withHub(async (hub, projectPath) => {
    for (const message of [
      "",
      "Claude Code session completed.",
      "Can you approve the permission dialog?",
      "Which task should I work on next?",
    ]) {
      const result = hub.captureCandidate({ projectPath, agent: "claude-code", message });
      assert.equal(result.action, "discarded");
    }
    assert.equal(hub.storage.listFixes(projectPath).length, 0);
  });
});

test("stores monitoring updates as expiring session events instead of fixes", async () => {
  await withHub(async (hub, projectPath) => {
    const result = hub.captureCandidate({
      projectPath,
      agent: "claude-code",
      source: "stop-hook",
      message: "Holding steady at 15:01 ET; broker remains flat and nothing changed.",
    });

    assert.equal(result.reason, "stored_session_event");
    assert.equal(hub.storage.listFixes(projectPath).length, 0);
    assert.equal(hub.storage.listSessionEvents(projectPath).length, 1);
  });
});

test("stores verified fixes with extracted evidence and rejects duplicates", async () => {
  await withHub(async (hub, projectPath) => {
    const candidate = {
      projectPath,
      agent: "claude-code",
      source: "stop-hook",
      message: "Fixed close-fill reconciliation. Files changed: src/reconcile.js. Commit: 77eae8e. Verification: npm test passed. Residual risk: live broker timing remains.",
    };
    const accepted = hub.captureCandidate(candidate);
    const duplicate = hub.captureCandidate(candidate);
    const stored = hub.storage.getFix(accepted.recordId);

    assert.equal(accepted.reason, "accepted_fix");
    assert.equal(duplicate.reason, "discarded_duplicate");
    assert.equal(stored.qualityStatus, "verified");
    assert.equal(stored.verification, "npm test passed.");
    assert.deepEqual(stored.filesChanged, ["src/reconcile.js"]);
    assert.equal(stored.commitSha, "77eae8e");
    assert.equal(stored.residualRisk, "live broker timing remains.");
  });
});

test("stores unverified fixes (files + commit, no verification) without inventing evidence", async () => {
  await withHub(async (hub, projectPath) => {
    const accepted = hub.captureCandidate({
      projectPath,
      agent: "codex",
      message: "Implemented deterministic context ranking. Files changed: src/contextRanking.js. Commit: abc1234.",
    });
    const stored = hub.storage.getFix(accepted.recordId);

    assert.equal(accepted.reason, "accepted_fix");
    assert.equal(stored.qualityStatus, "unverified");
    assert.equal(stored.verification, null);
  });
});

test("keyword-only prose is demoted to an expiring session event, not a durable fix", async () => {
  await withHub(async (hub, projectPath) => {
    const result = hub.captureCandidate({
      projectPath,
      agent: "codex",
      message: "Implemented deterministic context ranking.",
    });
    assert.equal(result.reason, "stored_session_event");
    assert.equal(hub.storage.listFixes(projectPath).length, 0);
    assert.equal(hub.storage.listSessionEvents(projectPath).length, 1);
  });
});

test("stores structured research findings", async () => {
  await withHub(async (hub, projectPath) => {
    const accepted = hub.captureCandidate({
      projectPath,
      agent: "codex",
      message: "Question: Why did fills fail? Finding: The watcher cancelled exits too early. Verification: confirmed in rolled logs.",
    });
    const stored = hub.storage.getResearch(accepted.recordId);

    assert.equal(accepted.reason, "accepted_research");
    assert.equal(stored.question, "Why did fills fail?");
    assert.equal(stored.finding, "The watcher cancelled exits too early.");
    assert.equal(stored.qualityStatus, "verified");
  });
});

test("applies an unambiguous task transition", async () => {
  await withHub(async (hub, projectPath) => {
    const task = hub.addTask({ type: "chore", projectPath, title: "Repair fill watcher" });
    const result = hub.captureCandidate({
      projectPath,
      agent: "claude-code",
      message: `Task ${task.id} is blocked: missing broker access`,
    });

    assert.equal(result.reason, "accepted_task_update");
    assert.equal(hub.storage.getTask(task.id).status, "blocked");
    assert.equal(hub.storage.getTask(task.id).blockReason, "missing broker access");
  });
});
