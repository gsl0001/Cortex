import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkCliAuth, checkWorktreeViability, createPreflight } from "../src/preflight.js";
import { parseReviewVerdict, buildReviewPrompt } from "../src/reviewer.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-preflight-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("checkCliAuth: expired or near-expiry OAuth fails; future ok; missing file assumed ok", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "creds.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
    const expired = checkCliAuth({ credentialsPath: file });
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /\/login/);

    // expires in 5 minutes — inside the 30-minute margin, still a fail (would die mid-window)
    await writeFile(file, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 5 * 60_000 } }));
    assert.equal(checkCliAuth({ credentialsPath: file }).ok, false);

    await writeFile(file, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 12 * 3_600_000 } }));
    assert.equal(checkCliAuth({ credentialsPath: file }).ok, true);

    // missing file: API-key/codex setups don't have one — never block on that alone
    assert.equal(checkCliAuth({ credentialsPath: join(dir, "nope.json") }).ok, true);
  });
});

test("checkWorktreeViability dry-runs the exact worktree operation", () => {
  const calls = [];
  const okRun = (_cmd, args) => { calls.push(args); return ""; };
  assert.equal(checkWorktreeViability({ repo: "C:/repo", worktreesDir: "C:/wt", run: okRun }).ok, true);
  assert.equal(calls[0][2], "worktree");
  assert.equal(calls[0][3], "add");

  const failRun = (_cmd, args) => {
    if (args[3] === "add") throw new Error("fatal: not a git repository");
    return "";
  };
  const failed = checkWorktreeViability({ repo: "C:/broken", worktreesDir: "C:/wt", run: failRun });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /C:\/broken/);
});

test("createPreflight caches per TTL, scopes auth to claude-code, and reset() clears the cache", () => {
  let authCalls = 0;
  let worktreeCalls = 0;
  let clock = 1_000_000;
  const preflight = createPreflight({
    ttlMs: 1000,
    now: () => clock,
    authCheck: () => { authCalls += 1; return { ok: false, reason: "OAuth token expired — run /login" }; },
    worktreeCheck: () => { worktreeCalls += 1; return { ok: true }; },
  });

  // codex-only tick: OAuth is irrelevant, only the worktree probe runs
  const codexOnly = preflight.check({ projects: ["C:/a"], agentsNeeded: new Set(["codex"]) });
  assert.equal(codexOnly.ok, true);
  assert.equal(authCalls, 0);
  assert.equal(worktreeCalls, 1);

  const first = preflight.check({ projects: ["C:/a"], agentsNeeded: new Set(["claude-code"]) });
  assert.equal(first.ok, false);
  assert.match(first.problems[0], /\/login/);
  assert.equal(authCalls, 1);
  assert.equal(worktreeCalls, 1); // cached project result reused

  preflight.check({ projects: ["C:/a"], agentsNeeded: new Set(["claude-code"]) });
  assert.equal(authCalls, 1, "within TTL: cached");

  clock += 1500;
  preflight.check({ projects: ["C:/a"], agentsNeeded: new Set(["claude-code"]) });
  assert.equal(authCalls, 2, "past TTL: re-checked");
  assert.equal(worktreeCalls, 2);

  preflight.reset();
  preflight.check({ projects: ["C:/a"], agentsNeeded: new Set(["claude-code"]) });
  assert.equal(authCalls, 3, "reset clears the cache immediately");
});

test("parseReviewVerdict extracts the verdict line; unparseable output is null", () => {
  assert.deepEqual(parseReviewVerdict("No findings.\nVERDICT: clean").verdict, "clean");
  assert.deepEqual(parseReviewVerdict("- token in src/x.js\nVERDICT: concerns").verdict, "concerns");
  assert.equal(parseReviewVerdict("I could not review this."), null);
  assert.equal(parseReviewVerdict(""), null);
});

test("buildReviewPrompt scopes the reviewer to security/scope checks and includes the diff", () => {
  const prompt = buildReviewPrompt({ title: "Tidy imports", acceptanceCriteria: "no behavior change" }, "diff --git a/x b/x");
  assert.match(prompt, /Tidy imports/);
  assert.match(prompt, /secrets/i);
  assert.match(prompt, /VERDICT: clean/);
  assert.match(prompt, /diff --git/);
});
