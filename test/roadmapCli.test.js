import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = new URL("../src/cli.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function run(dbPath, args) {
  const result = spawnSync(process.execPath, ["src/cli.js", ...args, "--db", dbPath], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function payload() {
  return {
    version: 1,
    goal: {
      title: "Ship result", outcome: "Verified result", targetDate: "2026-07-31",
      weeklyCapacity: 3, activeRank: 1,
      criteria: [{ key: "c1", text: "Verification passes", taskKeys: ["t1"] }],
    },
    milestones: [{ key: "m1", title: "Baseline", order: 1, dueDate: "2026-07-05" }],
    tasks: [{
      key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1,
      title: "Run verification", priority: "high", acceptanceCriteria: "Evidence saved",
      verificationCommand: "npm test", scheduledFor: "2026-06-29",
    }],
  };
}

test("roadmap CLI: propose, approve, show, portfolio, week", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-rmcli-"));
  const dbPath = join(dir, "cli.sqlite");
  const proposalFile = join(dir, "proposal.json");
  await writeFile(proposalFile, JSON.stringify(payload()));
  try {
    const added = run(dbPath, ["roadmap", "proposal-add", "--project", dir, "--agent", "codex", "--file", proposalFile, "--json"]);
    assert.equal(added.code, 0, added.err);
    const proposal = JSON.parse(added.out);
    assert.equal(proposal.status, "pending");

    const approved = run(dbPath, ["roadmap", "proposal-approve", "--id", proposal.id, "--agent", "human", "--json"]);
    assert.equal(approved.code, 0, approved.err);
    const roadmap = JSON.parse(approved.out);
    assert.equal(roadmap.goal.status, "active");
    assert.equal(roadmap.tasks.length, 1);

    const shown = run(dbPath, ["roadmap", "show", "--project", dir, "--json"]);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(JSON.parse(shown.out).goal.id, roadmap.goal.id);

    const goals = run(dbPath, ["goals", "--today", "2026-06-29", "--json"]);
    assert.equal(goals.code, 0, goals.err);
    const portfolio = JSON.parse(goals.out);
    assert.equal(portfolio.projects.length, 1);
    assert.equal(portfolio.nextAction.id, roadmap.tasks[0].id);

    const week = run(dbPath, ["week", "show", "--start", "2026-06-29", "--capacity", "6", "--json"]);
    assert.equal(week.code, 0, week.err);
    assert.equal(JSON.parse(week.out).totalCapacity, 6);

    const planned = run(dbPath, ["week", "auto-plan", "--start", "2026-06-29", "--capacity", "6", "--agent", "human", "--json"]);
    assert.equal(planned.code, 0, planned.err);
    assert.equal(JSON.parse(planned.out).weekStart, "2026-06-29");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("roadmap CLI rejects a cross-project link with a nonzero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-rmcli-"));
  const dbPath = join(dir, "cli.sqlite");
  const proposalFile = join(dir, "bad.json");
  // seed a foreign-project task, then try to link it
  run(dbPath, ["task", "add", "--project", `${dir}-other`, "--title", "Foreign", "--type", "chore", "--json"]);
  const foreign = JSON.parse(run(dbPath, ["tasks", "--project", `${dir}-other`, "--json"]).out)[0];
  const bad = payload();
  bad.tasks = [{ key: "t1", action: "link", taskId: foreign.id, milestoneKey: "m1", number: "1.1", order: 1 }];
  await writeFile(proposalFile, JSON.stringify(bad));
  try {
    const res = run(dbPath, ["roadmap", "proposal-add", "--project", dir, "--agent", "codex", "--file", proposalFile, "--json"]);
    assert.equal(res.code, 1);
    assert.match(res.err, /same project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
