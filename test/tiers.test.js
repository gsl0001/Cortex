import "./helpers/pinEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortexStorage, normalizeProjectPath } from "../src/storage.js";
import { projectTier, setProjectTier, isPinnedWatch, atLeast, autopilotKey, parseNeverAutopilot } from "../src/tiers.js";

test("CORTEX_NEVER_AUTOPILOT env string is comma-split, trimmed, and normalized", () => {
  // Paths are placed under os.tmpdir() so normalizeProjectPath skips git-root
  // resolution entirely (see storage.js's isUnderTmpdir), keeping this
  // deterministic without depending on any real git repo.
  const repoA = join(tmpdir(), "Never-Autopilot-Repo-A");
  const repoB = join(tmpdir(), "never-autopilot-repo-b");
  // Trailing separator (empty final entry) and mixed casing/spacing.
  const derived = parseNeverAutopilot(` ${repoA} , ${repoB.toUpperCase()},`);
  assert.equal(derived.size, 2); // trailing separator produced no 3rd (empty) entry
  assert.ok(derived.has(autopilotKey(normalizeProjectPath(repoA))));
  assert.ok(derived.has(autopilotKey(normalizeProjectPath(repoB))));
});

async function withStorage(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-tiers-"));
  const storage = new CortexStorage({ dbPath: join(dir, "t.sqlite") });
  try { await fn(storage); } finally { storage.close?.(); await rm(dir, { recursive: true, force: true }); }
}

test("unset projects start at watch, never autonomous by accident", () => withStorage((storage) => {
  assert.equal(projectTier(storage, "C:/work/noteapp"), "watch");
}));

test("the legacy enrollment list still reads as auto, so existing installs keep their history", () => withStorage((storage) => {
  storage.setSetting("dispatcher.projects", ["C:/work/sitelogs"]);
  assert.equal(projectTier(storage, "C:/work/sitelogs"), "auto");
  // An explicit tier overrides the legacy list rather than being shadowed by it.
  setProjectTier(storage, "C:/work/sitelogs", "assist");
  assert.equal(projectTier(storage, "C:/work/sitelogs"), "assist");
}));

test("tiers set explicitly are readable per project", () => withStorage((storage) => {
  setProjectTier(storage, "C:/work/sleep", "auto");
  setProjectTier(storage, "C:/work/ideas", "plan");
  assert.equal(projectTier(storage, "C:/work/sleep"), "auto");
  assert.equal(projectTier(storage, "C:/work/ideas"), "plan");
}));

test("a pre-existing plain-string tier setting still reads", () => withStorage((storage) => {
  storage.setSetting("autopilot.tier.c:/work/legacy", "auto");
  assert.equal(projectTier(storage, "C:/work/legacy"), "auto");
}));

test("the live-money repo is pinned at watch and cannot be promoted by any write", () => withStorage((storage) => {
  assert.equal(isPinnedWatch("C:/work/master"), true);
  for (const tier of ["plan", "assist", "auto"]) {
    assert.throws(() => setProjectTier(storage, "C:/work/master", tier), /pinned at watch/);
  }
  assert.equal(projectTier(storage, "C:/work/master"), "watch");
  // Even a direct settings write — or the legacy enrollment list — cannot raise it.
  storage.setSetting("autopilot.tier.c:/work/master", "auto");
  storage.setSetting("dispatcher.projects", ["C:/work/master"]);
  assert.equal(projectTier(storage, "C:/work/master"), "watch");
}));

test("an unknown tier is refused rather than silently stored", () => withStorage((storage) => {
  assert.throws(() => setProjectTier(storage, "C:/work/sleep", "autonomous"), /unknown tier/);
  assert.equal(projectTier(storage, "C:/work/sleep"), "watch");
}));

test("atLeast orders the dial", () => {
  assert.equal(atLeast("auto", "assist"), true);
  assert.equal(atLeast("plan", "assist"), false);
  assert.equal(atLeast("watch", "watch"), true);
});
