// Pre-flight checks the dispatcher runs before spending agent runs. Both failure storms in
// the live data were environmental and knowable in advance: 39 runs burned on an expired
// claude CLI OAuth token, 9 on a repo where `git worktree add` couldn't succeed. Checking
// first turns a night of failed runs into one held queue + one notification.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const AUTH_MARGIN_MS = Number(process.env.CORTEX_AUTH_MARGIN_MIN || 30) * 60_000;

// claude CLI OAuth expiry, read from the credentials file the CLI itself maintains.
// Headless runs cannot re-login (exit 1 until an interactive /login), so a token that is
// expired — or will expire within the margin — fails the check. A missing/unreadable file is
// treated as ok: API-key auth and codex runs don't use this file, and the spawn-time failure
// classifier still catches a genuine auth failure.
export function checkCliAuth({ credentialsPath = join(homedir(), ".claude", ".credentials.json"), now = Date.now() } = {}) {
  let expiresAt;
  try {
    expiresAt = JSON.parse(readFileSync(credentialsPath, "utf8"))?.claudeAiOauth?.expiresAt;
  } catch {
    return { ok: true, reason: "credentials file unreadable — assuming non-OAuth auth" };
  }
  if (typeof expiresAt !== "number") return { ok: true, reason: "no OAuth expiry recorded" };
  if (expiresAt <= now + AUTH_MARGIN_MS) {
    const when = new Date(expiresAt).toLocaleString();
    return { ok: false, reason: `claude CLI OAuth token ${expiresAt <= now ? "expired" : "expires"} ${when} — run /login before enabling Autopilot` };
  }
  return { ok: true, expiresAt };
}

// Can this repo actually host a run worktree? Dry-run the exact operation (add + remove a
// throwaway detached worktree) rather than guessing from repo state.
export function checkWorktreeViability({ repo, worktreesDir, run = execFileSync } = {}) {
  const probePath = `${worktreesDir}/preflight-${randomUUID().slice(0, 8)}`;
  try {
    run("git", ["-C", repo, "worktree", "add", "--detach", probePath], { encoding: "utf8", timeout: 15000 });
  } catch (error) {
    return { ok: false, reason: `git worktree add failed for ${repo}: ${String(error.message).slice(0, 200)}` };
  }
  try {
    run("git", ["-C", repo, "worktree", "remove", "--force", probePath], { encoding: "utf8", timeout: 15000 });
  } catch { /* probe removal is best-effort; prune will reap it */ }
  return { ok: true };
}

// Cached preflight for the dispatcher: one auth check per TTL, one worktree probe per
// project per TTL. Returns { ok, problems } where problems are human-readable strings.
export function createPreflight({ ttlMs = Number(process.env.CORTEX_PREFLIGHT_TTL_MIN || 30) * 60_000, authCheck = checkCliAuth, worktreeCheck = checkWorktreeViability, worktreesDir = join(tmpdir(), "cortex-preflight"), now = Date.now } = {}) {
  let authResult = null;
  let authCheckedAt = 0;
  const projectResults = new Map(); // repo -> { result, at }

  return {
    check({ projects = [], agentsNeeded = new Set() } = {}) {
      const problems = [];
      const t = now();
      // OAuth only gates claude-code runs; codex-only ticks skip it.
      if (agentsNeeded.has("claude-code")) {
        if (!authResult || t - authCheckedAt > ttlMs) {
          authResult = authCheck();
          authCheckedAt = t;
        }
        if (!authResult.ok) problems.push(authResult.reason);
      }
      for (const repo of projects) {
        const cached = projectResults.get(repo);
        let result = cached && t - cached.at <= ttlMs ? cached.result : null;
        if (!result) {
          result = worktreeCheck({ repo, worktreesDir });
          projectResults.set(repo, { result, at: t });
        }
        if (!result.ok) problems.push(result.reason);
      }
      return { ok: problems.length === 0, problems };
    },
    // A failed check must not stay cached after the human fixes the cause — let them retry now.
    reset() { authResult = null; authCheckedAt = 0; projectResults.clear(); },
  };
}
