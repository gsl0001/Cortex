import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createCortex, createClaudeHookContext } from "../src/index.js";

test("computeStats aggregates tokens, capture outcomes, and record counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-stats-"));
  const hub = createCortex({ dbPath: join(dir, "s.sqlite") });
  try {
    hub.storage.recordMetric("recall_injected", dir, { usedTokens: 100, maxTokens: 1200, dropped: 0 });
    hub.storage.recordMetric("recall_injected", dir, { usedTokens: 300, maxTokens: 1200, dropped: 1 });
    hub.storage.recordMetric("capture_outcome", dir, { action: "accepted", reason: "accepted_fix", recordType: "fix" });
    hub.storage.recordMetric("capture_outcome", dir, { action: "discarded", reason: "discarded_near_duplicate", recordType: "fix" });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "f", filesChanged: [] });

    const stats = hub.stats({ projectPath: dir });
    assert.equal(stats.recallCount, 2);
    assert.equal(stats.avgTokens, 200);
    assert.equal(stats.captureByReason.accepted_fix, 1);
    assert.equal(stats.captureByReason.discarded_near_duplicate, 1);
    assert.equal(stats.records.fix, 1);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeStats reports recall usefulness rate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-useful-"));
  const hub = createCortex({ dbPath: join(dir, "u.sqlite") });
  try {
    hub.upsertProjectProfile({ projectPath: dir, name: "Test", mode: "general", summary: "" });
    // a recall that injected no fix content can't be "useful" -> excluded from the denominator
    hub.storage.recordMetric("recall_injected", dir, { usedTokens: 10, maxTokens: 1200, injectedFixIds: [], injectedFilesChanged: [] });

    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "seed retry fix", filesChanged: ["retry.js"], verification: "npm test passed" });
    await createClaudeHookContext(hub, { cwd: dir, branch: "retry-hardening" }); // injects retry.js -> counted in the denominator, hit
    hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed retry race. Files changed: retry.js. Verification: npm test passed" });

    await createClaudeHookContext(hub, { cwd: dir, branch: "retry-hardening" }); // injects retry.js again -> counted, but no matching fix follows (miss)

    const stats = hub.stats({ projectPath: dir });
    assert.equal(stats.recallInjectedWithFixes, 2);
    assert.equal(stats.recallUsefulCount, 1);
    assert.equal(stats.recallUsefulRatePct, 50);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("every capture candidate records a capture_outcome metric", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-capmetric-"));
  const hub = createCortex({ dbPath: join(dir, "c.sqlite") });
  try {
    hub.captureCandidate({ projectPath: dir, agent: "a", message: "Implemented deterministic ranking." });
    hub.captureCandidate({ projectPath: dir, agent: "a", message: "Which task is next?" });
    const outcomes = hub.storage.listMetrics(dir, { kind: "capture_outcome" });
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes.some((event) => event.payload.reason === "stored_session_event"), true);
    assert.equal(outcomes.some((event) => event.payload.reason === "discarded_low_signal"), true);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub.sweep deletes expired session events and reports counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-sweep-"));
  const hub = createCortex({ dbPath: join(dir, "w.sqlite") });
  try {
    hub.storage.insertSessionEvent({ id: randomUUID(), projectPath: dir, agent: "a", source: "s", summary: "old", expiresAt: new Date(Date.now() - 86400000).toISOString() });
    const result = hub.sweep();
    assert.equal(result.sessionEventsDeleted, 1);
    assert.equal(typeof result.metricsDeleted, "number");
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("goalsViewedCount reflects machine-scoped goal-portfolio views, not per-project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-goalsview-"));
  const hub = createCortex({ dbPath: join(dir, "gv.sqlite") });
  try {
    hub.upsertProjectProfile({ projectPath: dir, name: "Test", mode: "general", summary: "" });
    // getGoalsPortfolio records views under the reserved "machine" scope (they span projects);
    // a real project's stats must still surface them — reading per-project events yields 0.
    hub.storage.recordMetric("goals_viewed", "machine", {});
    hub.storage.recordMetric("goals_viewed", "machine", {});
    assert.equal(hub.stats({ projectPath: dir }).goalsViewedCount, 2);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
