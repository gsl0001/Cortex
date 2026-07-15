// Turns a finished run's committed branch into a mergeable result: a PR when the project
// has a remote, or a signal that the caller must merge locally when it doesn't (Task 4).
// Async on purpose: push/pr-create are network calls with 30s timeouts — execFileSync here
// froze the whole event loop (HTTP, other runs' stdout, timers) at every run finish.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Default runner resolves stdout; injected fakes may return a plain string (awaited transparently).
const defaultRun = async (cmd, args, opts) => (await execFileAsync(cmd, args, opts)).stdout;
const sh = async (cmd, args, repo, run) => String((await run(cmd, args, { cwd: repo, encoding: "utf8", timeout: 30000 })) ?? "").trim();

// Push the per-run branch and open a PR. No remote → caller must local-merge instead.
export async function integrateRun({ repo, branch, baseRef, title, hasRemote, run = defaultRun }) {
  if (!hasRemote) return { prUrl: null, branch, needsLocalMerge: true };
  await sh("git", ["push", "-u", "origin", branch], repo, run);
  // No --fill: gh rejects it alongside explicit --title/--body (mutually exclusive flags).
  const prUrl = await sh("gh", ["pr", "create", "--head", branch, "--base", baseRef, "--title", title, "--body", "Autopilot run"], repo, run);
  return { prUrl: prUrl || null, branch, needsLocalMerge: false };
}

// Local merge fallback (projects without a remote). Aborts + reports on conflict.
// This runs in the user's live checkout: refuse on a dirty tree rather than checking out
// over in-progress edits, and put the prior branch back if the merge doesn't land.
export async function localMerge({ repo, branch, baseRef, run = defaultRun }) {
  if (await sh("git", ["status", "--porcelain"], repo, run)) return { merged: false, dirty: true };
  const prior = await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo, run);
  await sh("git", ["checkout", baseRef], repo, run);
  try {
    await sh("git", ["merge", "--no-ff", branch, "-m", `merge ${branch}`], repo, run);
    return { merged: true };
  } catch {
    try { await sh("git", ["merge", "--abort"], repo, run); } catch { /* nothing to abort */ }
    try { if (prior && prior !== baseRef) await sh("git", ["checkout", prior], repo, run); } catch { /* stay on base */ }
    return { merged: false, conflict: true };
  }
}
