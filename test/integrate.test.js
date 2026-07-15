import test from "node:test";
import assert from "node:assert/strict";
import { integrateRun, localMerge } from "../src/integrate.js";

function fakeRun(outputs = {}) {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return outputs[args.join(" ")] ?? ""; };
  run.calls = calls;
  return run;
}

test("integrateRun pushes the branch and opens a PR when there's a remote", async () => {
  const run = fakeRun({ "pr create --head autopilot/t1 --base main --title Do it --body Autopilot run": "https://gh/pr/7\n" });
  const res = await integrateRun({ repo: "C:/repo", branch: "autopilot/t1", baseRef: "main", title: "Do it", hasRemote: true, run });
  assert.equal(res.prUrl, "https://gh/pr/7");
  assert.equal(res.needsLocalMerge, false);
  assert.ok(run.calls.some((c) => c[0] === "git" && c.includes("push")));
  assert.ok(run.calls.some((c) => c[0] === "gh" && c.includes("create")));
  // gh rejects --fill combined with explicit --title/--body; its presence meant no PR was ever created
  assert.ok(!run.calls.some((c) => c.includes("--fill")));
});

test("integrateRun signals local-merge when there is no remote", async () => {
  const run = fakeRun();
  const res = await integrateRun({ repo: "C:/repo", branch: "autopilot/t1", baseRef: "main", title: "x", hasRemote: false, run });
  assert.deepEqual(res, { prUrl: null, branch: "autopilot/t1", needsLocalMerge: true });
  assert.equal(run.calls.length, 0); // no push/PR without a remote
});

test("localMerge merges the run branch into the base", async () => {
  const run = fakeRun();
  const res = await localMerge({ repo: "C:/repo", branch: "autopilot/t1", baseRef: "main", run });
  assert.equal(res.merged, true);
  assert.ok(run.calls.some((c) => c.includes("merge")));
});

test("localMerge refuses a dirty working copy instead of checking out over it", async () => {
  // localMerge runs in the user's live checkout — mid-edit files must never be clobbered
  const run = fakeRun({ "status --porcelain": " M src/wip.js\n" });
  const res = await localMerge({ repo: "C:/repo", branch: "autopilot/t1", baseRef: "main", run });
  assert.deepEqual(res, { merged: false, dirty: true });
  assert.ok(!run.calls.some((c) => c.includes("checkout"))); // never touched the tree
});

test("localMerge puts the prior branch back after a conflict abort", async () => {
  const base = fakeRun({ "rev-parse --abbrev-ref HEAD": "feature\n" });
  const run = (cmd, args, opts) => {
    if (args[0] === "merge" && args.includes("--no-ff")) throw new Error("CONFLICT");
    return base(cmd, args, opts);
  };
  const res = await localMerge({ repo: "C:/repo", branch: "autopilot/t1", baseRef: "main", run });
  assert.deepEqual(res, { merged: false, conflict: true });
  // aborted, then restored the branch the user was on rather than stranding them on main
  assert.ok(base.calls.some((c) => c.includes("--abort")));
  assert.deepEqual(base.calls.at(-1).slice(1), ["checkout", "feature"]);
});
