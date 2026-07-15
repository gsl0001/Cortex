import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CortexStorage } from "../src/storage.js";

async function withStorage(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-metrics-"));
  const storage = new CortexStorage({ dbPath: join(dir, "m.sqlite") });
  try { await fn(storage, dir); } finally { storage.close(); await rm(dir, { recursive: true, force: true }); }
}

test("records and lists metric events with parsed payloads", async () => {
  await withStorage(async (storage, dir) => {
    storage.recordMetric("recall_injected", dir, { usedTokens: 120, maxTokens: 1200, dropped: 2 });
    storage.recordMetric("capture_outcome", dir, { action: "accepted", reason: "accepted_fix", recordType: "fix" });
    const events = storage.listMetrics(dir, { kind: "recall_injected" });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.usedTokens, 120);
    assert.equal(storage.listMetrics(dir).length, 2);
  });
});
