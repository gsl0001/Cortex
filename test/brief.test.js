import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packBrief } from "../src/tokenPacker.js";
import { buildProjectBrief } from "../src/brief.js";
import { createCortex } from "../src/index.js";

const estimate = (text) => Math.ceil(text.length / 4);

test("keeps pinned sections, truncates fields, and drops items over budget", () => {
  const packed = packBrief([
    { raw: true, text: "Project: Demo\nPath: C:/x" },
    { heading: "Recent Fixes:", items: ["a".repeat(400), "short fix"] },
    { raw: true, text: "Next Recommended Command: npm test" },
  ], { maxTokens: 20, estimateTokens: estimate, fieldChars: 50 });

  assert.match(packed.text, /Project: Demo/);
  assert.match(packed.text, /Next Recommended Command: npm test/);
  assert.equal(packed.text.includes("a".repeat(400)), false); // truncated
  assert.equal(packed.dropped >= 1, true);
  assert.match(packed.text, /omitted to fit budget/);
});

test("buildProjectBrief returns token usage and keeps the skeleton", () => {
  const brief = buildProjectBrief({
    projectPath: "C:/demo",
    profile: { name: "Demo", mode: "trading", summary: "ops", standardCommands: ["npm test"], risks: ["latency"] },
    tasks: [{ id: "t1", title: "Repair watcher", status: "in_progress", priority: "high" }],
    research: [],
    fixes: [{ id: "f1", summary: "Fixed close fill", verification: "npm test" }],
    sessions: [],
    context: {},
    maxTokens: 1200,
    fieldChars: 160,
  });
  assert.match(brief.text, /Project: Demo/);
  assert.match(brief.text, /Fixed close fill/);
  assert.equal(typeof brief.usedTokens, "number");
  assert.equal(brief.maxTokens, 1200);
});

test("buildBrief budgets tokens and hides superseded fixes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-brief-"));
  const hub = createCortex({ dbPath: join(dir, "b.sqlite") });
  try {
    const old = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "older close fill fix", filesChanged: ["r.js"] });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "newer close fill fix", filesChanged: ["r.js"], supersedesId: old.id });
    const brief = hub.buildBrief({ projectPath: dir, maxTokens: 1200 });
    // superseded fix is hidden from "Recent Fixes" but intentionally surfaced under "Previously Attempted"
    assert.match(brief.text, /newer close fill fix/);
    assert.match(brief.text, /Previously Attempted[\s\S]*older close fill fix/);
    assert.equal(brief.maxTokens, 1200);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
