import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-throughput-"));
  const hub = createCortex({ dbPath: join(dir, "t.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("finishRun persists verdict columns and markRunAutoMerged stamps after the fact", () =>
  withHub(async (hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "verdict columns" });
    const run = hub.storage.startRun({ agent: "claude-code", taskId: task.id });
    hub.storage.finishRun(run.id, {
      outcome: "success", verificationExit: 0,
      reviewVerdict: "clean", reviewNotes: "no findings", diffConfined: true,
    });
    let row = hub.storage.getRun(run.id);
    assert.equal(row.reviewVerdict, "clean");
    assert.equal(row.reviewNotes, "no findings");
    assert.equal(row.diffConfined, 1);
    assert.equal(row.autoMerged, null); // merge outcome not yet known at finish time

    row = hub.storage.markRunAutoMerged(run.id, true);
    assert.equal(row.autoMerged, 1);
  }));

test("weeklyRunRollup groups by ISO week start (Monday) with verified/clean/merged counts", () =>
  withHub(async (hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "rollup runs" });
    const mk = (startedAt, patch) => {
      const run = hub.storage.startRun({ agent: "claude-code", taskId: task.id });
      hub.storage.finishRun(run.id, { outcome: "success", ...patch });
      hub.storage.db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(startedAt, run.id);
      return run.id;
    };
    // Mon + Tue of the same week: Monday must map to its own week, not the previous one
    mk("2026-07-13T08:00:00.000Z", { verificationExit: 0, reviewVerdict: "clean" });
    const merged = mk("2026-07-14T08:00:00.000Z", { verificationExit: 0, reviewVerdict: "clean" });
    hub.storage.markRunAutoMerged(merged, true);
    mk("2026-07-08T08:00:00.000Z", { outcome: "fail" }); // previous week, unverified

    const rollup = hub.storage.weeklyRunRollup({ weeks: 4, now: new Date("2026-07-16T00:00:00Z") });
    assert.deepEqual(rollup.map((r) => r.weekStart), ["2026-07-13", "2026-07-06"]);
    const [thisWeek, lastWeek] = rollup;
    assert.equal(thisWeek.runs, 2);
    assert.equal(thisWeek.successes, 2);
    assert.equal(thisWeek.verifiedGreen, 2);
    assert.equal(thisWeek.reviewerClean, 2);
    assert.equal(thisWeek.autoMerged, 1);
    assert.equal(lastWeek.runs, 1);
    assert.equal(lastWeek.successes, 0);
  }));

test("search records a search_used metric for external calls only", () =>
  withHub(async (hub, dir) => {
    hub.search({ projectPath: dir, query: "anything" });
    hub.search({ projectPath: dir, query: "anything", internal: true });
    const used = hub.storage.listMetrics(dir, { kind: "search_used" });
    assert.equal(used.length, 1);
  }));
