import { execFileSync } from "node:child_process";

const git = (repo, args, run) => String(run("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 15000 }) || "").trim();

export const runBranch = (taskId) => `autopilot/${taskId}`;

export function hasRemote(repo, run = execFileSync) {
  // integrateRun pushes to "origin" specifically — a repo whose only remote is named
  // something else must take the local-merge path, not fail the push silently.
  try { return git(repo, ["remote"], run).split(/\r?\n/).includes("origin"); } catch { return false; }
}

// baseRef: the producer's branch for a dependent run, else the project's default branch.
// -B (not -b): a retry of a previously-failed task finds its autopilot/<taskId> branch already
// existing (nothing deletes run branches), and -b would refuse to relaunch. Resetting to baseRef
// is safe — only a failed attempt leaves the branch behind, and the retry supersedes it.
export function createRunWorktree({ repo, worktreesDir, taskId, baseRef, run = execFileSync }) {
  const path = `${worktreesDir}/autopilot-${taskId}`;
  const branch = runBranch(taskId);
  git(repo, ["worktree", "add", path, "-B", branch, baseRef], run);
  return { path, branch };
}

export function removeRunWorktree({ repo, path, run = execFileSync }) {
  try { git(repo, ["worktree", "remove", "--force", path], run); } catch { /* already gone */ }
  git(repo, ["worktree", "prune"], run);
}

// Reap orphaned per-run worktrees for one project repo, using its worktree registry
// (worktrees are registered per-repo, so we must sweep project-by-project). An "autopilot-<id>"
// worktree whose <id> is not in activeTaskIds is a crash/kill leftover -> remove it.
export function sweepProjectWorktrees({ repo, activeTaskIds, run = execFileSync }) {
  let out;
  try { out = git(repo, ["worktree", "list", "--porcelain"], run); } catch { return 0; }
  let reaped = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    // Anchor on a path separator: a foreign worktree merely *ending* in "…my-autopilot-x"
    // must not be force-removed at startup.
    const m = path.match(/[/\\]autopilot-([^/\\]+)$/);
    if (!m) continue;
    if (activeTaskIds.has(m[1])) continue;
    removeRunWorktree({ repo, path, run });
    reaped += 1;
  }
  return reaped;
}
