import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function run(dbPath, args) {
  const result = spawnSync(process.execPath, ["src/cli.js", ...args, "--db", dbPath], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

async function withDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-cli-"));
  const dbPath = join(dir, "cli.sqlite");
  try { await fn(dbPath, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("--flag=value form passes a value that looks like another flag, or is empty", async () => {
  await withDb(async (dbPath, dir) => {
    const added = run(dbPath, ["task", "add", "--project", dir, "--title=--priority", "--type", "chore", "--json"]);
    assert.equal(added.code, 0, added.err);
    assert.equal(JSON.parse(added.out).title, "--priority");

    const emptyFiles = run(dbPath, ["task", "add", "--project", dir, "--title", "x", "--files=", "--type", "chore", "--json"]);
    assert.equal(emptyFiles.code, 0, emptyFiles.err);
    assert.deepEqual(JSON.parse(emptyFiles.out).relatedFiles, []);
  });
});

test("a flag with no value (space-separated form) fails cleanly instead of silently storing 'true'", async () => {
  await withDb(async (dbPath, dir) => {
    // --title has no value before the next flag -> must fail, not silently store the string "true"
    const result = run(dbPath, ["task", "add", "--project", dir, "--title", "--priority", "high"]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /title is required/);
  });
});

test("task claim/session finish with a missing --id fail with a clean message, not a raw SQLite error", async () => {
  await withDb(async (dbPath) => {
    const claim = run(dbPath, ["task", "claim", "--agent", "claude-code"]);
    assert.notEqual(claim.code, 0);
    assert.match(claim.err, /id is required/);
    assert.doesNotMatch(claim.err, /SQLite|bound/i);

    const finish = run(dbPath, ["session", "finish"]);
    assert.notEqual(finish.code, 0);
    assert.match(finish.err, /id is required/);
    assert.doesNotMatch(finish.err, /SQLite|bound/i);
  });
});

test("roadmap proposal-add with a missing --file fails with a clean message, not a raw fs error", async () => {
  await withDb(async (dbPath, dir) => {
    const result = run(dbPath, ["roadmap", "proposal-add", "--project", dir, "--agent", "codex"]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /--file is required/);
    assert.doesNotMatch(result.err, /ENOENT|"path" argument/);
  });
});

test("doctor --portfolio prints a concise report and lifecycle updates round-trip", async () => {
  await withDb(async (dbPath, dir) => {
    const profile = run(dbPath, [
      "profile", "upsert", "--project", dir, "--name", "Demo", "--mode", "product", "--summary", "Demo",
    ]);
    assert.equal(profile.code, 0, profile.err);

    const lifecycle = run(dbPath, ["project", "lifecycle", "--project", dir, "--state", "maintenance", "--json"]);
    assert.equal(lifecycle.code, 0, lifecycle.err);
    assert.equal(JSON.parse(lifecycle.out).state, "maintenance");

    const doctor = run(dbPath, ["doctor", "--portfolio", "--today", "2026-07-30"]);
    assert.equal(doctor.code, 0, doctor.err);
    assert.match(doctor.out, /Portfolio Doctor - 2026-07-30/);
    assert.match(doctor.out, /\[maintenance\] Demo/);

    const json = run(dbPath, ["doctor", "--portfolio", "--today", "2026-07-30", "--json"]);
    assert.equal(json.code, 0, json.err);
    assert.equal(JSON.parse(json.out).rows[0].lifecycle, "maintenance");
  });
});
