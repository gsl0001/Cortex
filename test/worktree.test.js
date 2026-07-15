import test from "node:test";
import assert from "node:assert/strict";
import { runBranch, hasRemote, createRunWorktree, removeRunWorktree, sweepProjectWorktrees } from "../src/worktree.js";

function fakeRun(outputs = {}) {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); const key = args.join(" "); return outputs[key] ?? ""; };
  run.calls = calls;
  return run;
}

test("runBranch derives the per-run branch name", () => {
  assert.equal(runBranch("abc123"), "autopilot/abc123");
});

test("hasRemote is true only when the repo has an origin remote", () => {
  assert.equal(hasRemote("C:/repo", fakeRun({ "-C C:/repo remote": "origin\n" })), true);
  assert.equal(hasRemote("C:/repo", fakeRun({ "-C C:/repo remote": "" })), false);
  // integrateRun pushes to origin specifically — any other remote can't be used, so this
  // repo must take the local-merge path instead of failing the push silently.
  assert.equal(hasRemote("C:/repo", fakeRun({ "-C C:/repo remote": "upstream\n" })), false);
  assert.equal(hasRemote("C:/repo", fakeRun({ "-C C:/repo remote": "upstream\norigin\n" })), true);
});

test("createRunWorktree adds a worktree on a per-run branch, reusable across retries", () => {
  const run = fakeRun();
  const { path, branch } = createRunWorktree({ repo: "C:/repo", worktreesDir: "C:/wt", taskId: "t1", baseRef: "main", run });
  assert.equal(branch, "autopilot/t1");
  assert.equal(path, "C:/wt/autopilot-t1");
  // -B, not -b: a retry finds autopilot/t1 already existing (run branches are never deleted),
  // and -b would refuse the relaunch — the exact failure that broke transient retries.
  assert.deepEqual(run.calls[0], ["git", "-C", "C:/repo", "worktree", "add", "C:/wt/autopilot-t1", "-B", "autopilot/t1", "main"]);
});

test("removeRunWorktree force-removes then prunes, tolerating a missing worktree", () => {
  const run = fakeRun();
  removeRunWorktree({ repo: "C:/repo", path: "C:/wt/autopilot-t1", run });
  assert.deepEqual(run.calls.map((c) => c[4]), ["remove", "prune"]);
});

test("sweepProjectWorktrees reaps autopilot worktrees whose task is not active", () => {
  const porcelain = [
    "worktree C:/repo", "HEAD abc", "branch refs/heads/main", "",
    "worktree C:/wt/autopilot-dead", "HEAD def", "branch refs/heads/autopilot/dead", "",
    "worktree C:/wt/autopilot-live", "HEAD ghi", "branch refs/heads/autopilot/live", "",
    // a developer's own worktree that merely ENDS in "autopilot-<x>" is not ours to reap
    "worktree C:/dev/my-autopilot-x", "HEAD jkl", "branch refs/heads/wip", "",
  ].join("\n");
  const run = fakeRun({ "-C C:/repo worktree list --porcelain": porcelain });
  const reaped = sweepProjectWorktrees({ repo: "C:/repo", activeTaskIds: new Set(["live"]), run });
  assert.equal(reaped, 1); // autopilot-dead reaped; autopilot-live, main, my-autopilot-x untouched
  assert.ok(run.calls.some((c) => c.includes("C:/wt/autopilot-dead") && c.includes("remove")));
  assert.ok(!run.calls.some((c) => c.includes("C:/wt/autopilot-live") && c.includes("remove")));
  assert.ok(!run.calls.some((c) => c.includes("C:/dev/my-autopilot-x")));
});
