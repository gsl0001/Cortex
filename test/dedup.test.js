import test from "node:test";
import assert from "node:assert/strict";
import { isNearDuplicate } from "../src/capturePolicy.js";

const recent = [
  { id: "1", signature: "fixed close fill reconciliation in reconcile module", verification: null, qualityStatus: "unverified" },
  { id: "2", signature: "added retry to broker websocket", verification: "npm test", qualityStatus: "verified" },
];

test("flags a reworded near-duplicate and reports the existing id", () => {
  const hit = isNearDuplicate(
    { signature: "fixed the close-fill reconciliation inside reconcile module", verification: "npm test" },
    recent, { threshold: 0.6 },
  );
  assert.equal(hit.duplicate, true);
  assert.equal(hit.existingId, "1");
  assert.equal(hit.existingVerified, false);
});

test("returns null for a distinct candidate", () => {
  assert.equal(
    isNearDuplicate({ signature: "rewrote the dashboard layout grid" }, recent, { threshold: 0.6 }),
    null,
  );
});

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-dedup-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("a reworded fix on the same file is discarded as a near-duplicate and can merge up verification", async () => {
  await withHub(async (hub, dir) => {
    const first = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Implemented deterministic context ranking for the brief builder. Files changed: src/contextRanking.js. Commit: abc1234.",
    });
    assert.equal(first.reason, "accepted_fix");
    const second = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Implemented deterministic context ranking for the brief builder now. Files changed: src/contextRanking.js. Verification: npm test passed.",
    });
    assert.equal(second.reason, "discarded_near_duplicate");
    assert.equal(second.recordId, first.recordId);
    assert.equal(hub.storage.listFixes(dir).length, 1);
    assert.equal(hub.storage.getFix(first.recordId).qualityStatus, "verified");
  });
});

test("two distinct fixes with near-identical wording stay distinct when they touch different files", async () => {
  // entity-anchored dedup: raw token overlap can't separate "login form" from "signup form"
  // (a one-word swap between genuinely different bugs), but the changed-file anchor can —
  // no shared file means no duplicate, at any text similarity.
  await withHub(async (hub, dir) => {
    const login = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Fixed validation on the login form submit handler. Files changed: src/login.js. Verification: npm test passed." });
    const signup = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Fixed validation on the signup form submit handler. Files changed: src/signup.js. Verification: npm test passed." });
    assert.equal(login.reason, "accepted_fix");
    assert.equal(signup.reason, "accepted_fix");
    assert.notEqual(login.recordId, signup.recordId);
  });
});
