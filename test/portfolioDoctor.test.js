import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex, formatPortfolioDoctor } from "../src/index.js";

test("portfolio doctor turns project history into lifecycle, next-action, and proof warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-portfolio-"));
  const dbPath = join(dir, "doctor.sqlite");
  const activePath = join(dir, "active");
  const researchPath = join(dir, "research-only");
  const hub = createCortex({ dbPath });
  try {
    hub.upsertProjectProfile({
      projectPath: activePath,
      name: "Active app",
      mode: "product",
      summary: "Ships things",
    });
    hub.setProjectLifecycle({ projectPath: activePath, state: "active" });
    hub.storage.insertGoal({
      id: "goal",
      projectPath: activePath,
      title: "Ship",
      outcome: "Live",
      successCriteria: [],
      targetDate: "2026-08-01",
      weeklyCapacity: 2,
      status: "active",
      activeRank: 1,
    });
    const first = hub.addTask({
      projectPath: activePath,
      type: "test",
      title: "Step 1 verify device",
      priority: "high",
    });
    const second = hub.addTask({
      projectPath: activePath,
      type: "test",
      title: "Step 2 submit build",
      priority: "high",
    });
    hub.blockTask({ id: second.id, reason: "Waiting on device", recheckAt: "2026-07-01" });
    const run = hub.storage.startRun({ taskId: first.id, agent: "codex" });
    hub.storage.finishRun(run.id, { outcome: "finished" });

    for (let i = 0; i < 3; i += 1) {
      hub.addResearchEntry({
        projectPath: researchPath,
        agent: "codex",
        question: `Question ${i}`,
        finding: `Finding ${i}`,
      });
    }

    const report = hub.portfolioDoctor({ today: "2026-07-30" });
    const active = report.rows.find(({ name }) => name === "Active app");
    const research = report.rows.find(({ projectPath }) => projectPath.endsWith("/research-only"));

    assert.equal(active.lifecycle, "active");
    assert.equal(active.nextAction.taskId, first.id);
    assert.equal(active.tasks.open, 2);
    assert.equal(active.tasks.evidenceContracts, 0);
    assert.equal(active.runs.unverified, 1);
    assert.deepEqual(
      active.issues.map(({ code }) => code)
        .filter((code) => !["lifecycle-unset", "suspicious-path"].includes(code)).sort(),
      ["missing-dependencies", "missing-evidence-contract", "overdue-recheck", "unverified-runs"].sort(),
    );
    assert.equal(research.profile, false);
    assert.equal(research.suggestedLifecycle, "maintenance");
    assert.equal(research.nextAction.kind, "profile");
    assert.ok(research.issues.some(({ code }) => code === "research-not-converted"));
    assert.equal(report.summary.overdueRechecks, 1);
    assert.match(formatPortfolioDoctor(report), /Portfolio Doctor - 2026-07-30/);
    assert.match(formatPortfolioDoctor(report), /Step 1 verify device/);

    assert.throws(
      () => hub.setProjectLifecycle({ projectPath: activePath, state: "busy" }),
      /state must be one of/,
    );
    assert.equal(hub.setProjectLifecycle({ projectPath: researchPath, state: "archived" }).state, "archived");
    const archived = hub.portfolioDoctor({ today: "2026-07-30" }).rows
      .find(({ projectPath }) => projectPath.endsWith("/research-only"));
    assert.equal(archived.lifecycle, "archived");
    assert.deepEqual(archived.issues, []);

    hub.setProjectLifecycle({ projectPath: join(dir, "second-active"), state: "active" });
    hub.setProjectLifecycle({ projectPath: join(dir, "third-active"), state: "active" });
    assert.throws(
      () => hub.setProjectLifecycle({ projectPath: join(dir, "fourth-active"), state: "active" }),
      /three projects are already active/,
    );
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
