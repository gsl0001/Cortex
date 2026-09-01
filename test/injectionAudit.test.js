// Injection-audit fixes (Aug 28): hash stability, raw budgets, citation attribution,
// IDF-weighted ranking, cross-project topic-scope exemption, JIT oversized ranking.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { packBrief } from "../src/tokenPacker.js";
import { rankFixes } from "../src/contextRanking.js";
import { buildProjectIndex, isOffTopic } from "../src/topicScope.js";
import { buildJitNote } from "../src/jit-recall.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-inject-"));
  const hub = createCortex({ dbPath: join(dir, "inject.sqlite") });
  try {
    await fn(hub, dir);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("contentText excludes the omitted-items footer so drop-count churn cannot change the hash", () => {
  const sections = [
    { raw: true, text: "Project: X" },
    { heading: "Items:", items: ["kept item"] },
    { heading: "Overflow:", items: ["dropped A".repeat(50), "dropped B".repeat(50)] },
  ];
  const small = packBrief(sections, { maxTokens: 20 });
  const sameContentMoreDrops = packBrief(
    [...sections.slice(0, 2), { heading: "Overflow:", items: ["x".repeat(400), "y".repeat(400), "z".repeat(400)] }],
    { maxTokens: 20 },
  );
  assert.equal(small.text.includes("omitted to fit budget"), true);
  assert.equal(small.contentText.includes("omitted to fit budget"), false);
  // different overflow tails, different drop counts — identical rendered content
  assert.equal(small.contentText, sameContentMoreDrops.contentText);
  assert.notEqual(small.text, sameContentMoreDrops.text);
});

test("raw sections are charged against the cap instead of reserving unbudgeted", () => {
  const packed = packBrief(
    [
      { raw: true, text: "H".repeat(600) },
      { raw: true, text: "I".repeat(600) },
      { raw: true, text: "J".repeat(600) },
    ],
    { maxTokens: 100 },
  );
  assert.equal(packed.usedTokens <= 100, true);
  assert.equal(packed.dropped >= 1, true); // at least the last raw section had no budget left
});

test("IDF weighting: a rare-term match outranks a term every candidate shares", () => {
  const entries = [
    { summary: "memory hub brief recall quarantine regression", filesChanged: [], createdAt: new Date().toISOString() },
    { summary: "memory hub brief recall styling tweak", filesChanged: [], createdAt: new Date().toISOString() },
    { summary: "memory hub brief recall other chore", filesChanged: [], createdAt: new Date().toISOString() },
  ];
  const ranked = rankFixes(entries, { goalText: "fix the quarantine memory regression" });
  assert.equal(ranked[0].summary.includes("quarantine"), true);
});

test("a record naming two or more foreign projects is a cross-project rule, not off-topic", () => {
  const index = buildProjectIndex([
    { projectPath: "C:/work/hubthing", name: "Hubthing" },
    { projectPath: "C:/work/autopilot", name: "Autopilot" },
    { projectPath: "C:/work/master", name: "Trading System" },
  ]);
  // names ONE foreign project -> still filtered
  assert.equal(isOffTopic("autopilot dispatch loop details", "C:/work/hubthing", index), true);
  // names TWO foreign projects -> cross-project rule, kept
  assert.equal(isOffTopic("never enroll trading master in autopilot", "C:/work/hubthing", index), false);
});

test("citation attribution: credited to the record's own project, deduped per session, channel-tagged", async () => {
  await withHub(async (hub, dir) => {
    const projectA = join(dir, "a");
    const projectB = join(dir, "b");
    hub.storage.upsertProjectProfile({ projectPath: projectA, name: "Alpha", summary: "s" });
    hub.storage.upsertProjectProfile({ projectPath: projectB, name: "Beta", summary: "s" });
    const fixId = "abcdef12-3456-7890-abcd-ef1234567890";
    hub.storage.insertFix({
      id: fixId, projectPath: projectB, agent: "t", summary: "beta-owned fix", filesChanged: ["x.js"],
    });
    const prefix = fixId.replace(/-/g, "").slice(0, 6);
    const message = `Applied the fix per [m:${prefix}]. Files changed: x.js; Verification: npm test passed`;
    const candidate = { projectPath: projectA, agent: "t", source: "test", message, sessionId: "s1" };
    hub.captureCandidate(candidate);
    hub.captureCandidate(candidate); // second Stop-hook fire, same session
    const citedA = hub.storage.listMetrics(projectA, { kind: "recall_cited" });
    const citedB = hub.storage.listMetrics(projectB, { kind: "recall_cited" });
    assert.equal(citedA.length, 0); // not credited to the session's project
    assert.equal(citedB.length, 1); // credited once to the record's project, deduped
    assert.equal(citedB[0].payload.resolved, true);
    assert.equal(citedB[0].payload.source, "unserved"); // never served to this session
    assert.equal(citedB[0].payload.sessionId, "s1");
  });
});

test("JIT oversized bucket serves the newest verified fix instead of going silent", () => {
  const fixes = Array.from({ length: 12 }, (_, i) => ({
    id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
    summary: `fix ${i}`,
    filesChanged: ["src/commands.js"],
    qualityStatus: i === 3 ? "verified" : "captured",
    verification: i === 3 ? "npm test" : null,
  }));
  const metrics = [];
  const storage = {
    getProjectProfile: () => ({ name: "p" }),
    listMetrics: () => [],
    listFixes: () => fixes,
    listLessons: () => [],
    recordMetric: (kind, project, payload) => metrics.push(payload),
  };
  const note = buildJitNote(storage, { projectPath: "C:/p", filePath: "src/commands.js", sessionId: "s1" });
  assert.equal(typeof note, "string");
  assert.equal(note.includes("12 prior fix(es)"), true);
  assert.equal(note.includes("fix 3"), true); // the verified one, not fixes[0]
  assert.equal(metrics[0].oversized, true);
  assert.equal(metrics[0].servedFixIds[0].endsWith("03"), true);
});

test("porter tokenizer: search matches morphological variants after migration", async () => {
  await withHub(async (hub, dir) => {
    const project = join(dir, "p");
    hub.storage.upsertProjectProfile({ projectPath: project, name: "P", summary: "s" });
    hub.storage.insertFix({
      id: "11111111-2222-3333-4444-555555555555", projectPath: project, agent: "t",
      summary: "fixes authentication caching regression", filesChanged: ["auth.js"],
    });
    hub.rebuildIndex();
    const { results } = hub.search({ projectPath: project, query: "authenticate cache", internal: true });
    assert.equal(results.length >= 1, true);
    assert.equal(results[0].title.includes("authentication"), true);
  });
});

test("memory_get resolves an [m:id] prefix to the full record and records the pull", async () => {
  await withHub(async (hub, dir) => {
    const project = join(dir, "p");
    hub.storage.upsertProjectProfile({ projectPath: project, name: "P", summary: "s" });
    const id = "deadbeef-0000-1111-2222-333344445555";
    hub.storage.insertFix({ id, projectPath: project, agent: "t", summary: "the full body", filesChanged: ["a.js"] });
    const record = hub.getRecord({ idPrefix: "[m:deadbe]", agent: "tester" });
    assert.equal(record.recordType, "fix");
    assert.equal(record.summary, "the full body");
    const pulled = hub.storage.listMetrics(project, { kind: "recall_pulled" });
    assert.equal(pulled.length, 1);
    assert.equal(pulled[0].payload.idPrefix, "deadbe");
    assert.equal(hub.getRecord({ idPrefix: "ffffff" }), null);
  });
});

test("brief renders the top record per section in full and the rest as stubs", async () => {
  await withHub(async (hub, dir) => {
    const project = join(dir, "p");
    hub.storage.upsertProjectProfile({ projectPath: project, name: "P", summary: "s" });
    for (let i = 0; i < 3; i += 1) {
      hub.storage.insertFix({
        id: `0000000${i}-1111-2222-3333-444455556666`, projectPath: project, agent: "t",
        summary: `paywall retry fix number ${i} with a long explanatory tail that a stub must not carry`,
        filesChanged: ["paywall.js"], verification: "npm test",
      });
    }
    const brief = hub.buildBrief({ projectPath: project, context: { goalText: "paywall retry work" } });
    const lines = brief.text.split("\n").filter((l) => l.includes("paywall retry fix"));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].includes("verified: npm test"), true); // top record: full form
    assert.equal(lines[1].includes("verified: npm test"), false); // stubs: clipped, tagged only
    assert.equal(lines[1].includes("[verified]"), true);
  });
});

test("semantic arm admits a paraphrase record that keyword overlap would drop", () => {
  const entries = [
    { summary: "login token refresh loop stalls on expiry", filesChanged: [], createdAt: new Date().toISOString() },
    { summary: "styles cleanup in the settings pane", filesChanged: [], createdAt: new Date().toISOString() },
  ];
  const context = { goalText: "debug authentication session renewal hang" }; // zero shared terms
  const withoutSemantic = rankFixes(entries, context);
  assert.equal(withoutSemantic.length, 0); // keyword gate drops everything
  const semantic = (entry) => (entry.summary.includes("token refresh") ? 0.8 : 0.1);
  const withSemantic = rankFixes(entries, context, semantic);
  assert.equal(withSemantic.length, 1);
  assert.equal(withSemantic[0].summary.includes("token refresh"), true);
});
