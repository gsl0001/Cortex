import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createCortex } from "../src/index.js";

test("search CLI returns ranked evidence and a bounded context pack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-search-cli-"));
  const dbPath = join(dir, "search.sqlite");
  const hub = createCortex({ dbPath });
  hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed close reconciliation. Verification: npm test passed." });
  hub.close();
  try {
    const result = spawnSync(process.execPath, [
      resolve("src/cli.js"), "--db", dbPath, "search", "--project", dir,
      "--query", "close reconciliation", "--max-tokens", "100", "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.results.length, 1);
    assert.equal(output.context.usedTokens <= 100, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fix added via the CLI (not a hook capture) is searchable without a manual index rebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-search-cli-fixadd-"));
  const dbPath = join(dir, "search.sqlite");
  try {
    const add = spawnSync(process.execPath, [
      resolve("src/cli.js"), "--db", dbPath, "fix", "add", "--project", dir,
      "--agent", "codex", "--summary", "Unique needle fix for the retry loop",
      "--verification", "npm test passed",
    ], { encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);

    const search = spawnSync(process.execPath, [
      resolve("src/cli.js"), "--db", dbPath, "search", "--project", dir,
      "--query", "needle fix retry", "--json",
    ], { encoding: "utf8" });
    assert.equal(search.status, 0, search.stderr);
    const output = JSON.parse(search.stdout);
    assert.equal(output.results.length, 1);
    assert.match(output.results[0].title, /Unique needle fix/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
