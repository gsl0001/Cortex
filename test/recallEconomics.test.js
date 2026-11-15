// Recall economics: which sessions pulled from memory vs spun up cold, per-project token
// waste, and the transcript-usage denominator — the visibility layer over the recall rails.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { classifySession, computeRecallEconomics, renderRecallEconomicsText, resolveSince } from "../src/recallEconomics.js";
import { createCortexServer } from "../src/server.js";

const offlineClient = { capture: async () => { throw Object.assign(new Error("offline"), { isHttpRejection: false }); } };

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-econ-"));
  const hub = createCortex({ dbPath: join(dir, "e.sqlite") });
  try {
    await fn(hub, dir);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const session = (over = {}) => ({
  briefsInjected: 0, jitNotes: 0, servedRecords: 0, briefTokens: 0, maxTokens: 600, cited: 0, useful: 0, ...over,
});

test("classifySession: hit, cold, thrash, quiet, silent", () => {
  assert.equal(classifySession(session({ briefsInjected: 1, servedRecords: 3, cited: 1 })), "hit");
  assert.equal(classifySession(session({ briefsInjected: 1, servedRecords: 3, useful: 1 })), "hit");
  assert.equal(classifySession(session({ briefsInjected: 2, servedRecords: 0 })), "cold");
  assert.equal(classifySession(session({ briefsInjected: 3, servedRecords: 4, briefTokens: 900 })), "thrash");
  assert.equal(classifySession(session({ briefsInjected: 2, servedRecords: 4, briefTokens: 1200 })), "quiet"); // normal pair at cap
  assert.equal(classifySession(session({ briefsInjected: 1, servedRecords: 4, briefTokens: 1300 })), "thrash"); // ≥2× cap
  assert.equal(classifySession(session({ briefsInjected: 1, servedRecords: 4, briefTokens: 500 })), "quiet");
  assert.equal(classifySession(session({ jitNotes: 1, servedRecords: 1 })), "quiet");
  assert.equal(classifySession(session()), "silent");
});

test("resolveSince accepts <n>d windows and ISO stamps, rejects garbage", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  assert.equal(resolveSince(undefined, now), "2026-08-19T00:00:00.000Z");
  assert.equal(resolveSince("7d", now), "2026-08-26T00:00:00.000Z");
  assert.equal(resolveSince("2026-08-01", now), "2026-08-01T00:00:00.000Z");
  assert.throws(() => resolveSince("banana", now), /since must be/);
});

test("computeRecallEconomics: per-session verdicts, project rollup, cross-project citation join", async () => {
  await withHub(async (hub, dir) => {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    hub.upsertProjectProfile({ projectPath: alpha, name: "Alpha", mode: "general", summary: "" });
    hub.upsertProjectProfile({ projectPath: beta, name: "Beta", mode: "general", summary: "" });
    const fixId = "abcdef12-3456-7890-abcd-ef1234567890";
    hub.storage.insertFix({ id: fixId, projectPath: beta, agent: "t", summary: "beta-owned fix", filesChanged: ["x.js"] });
    const s = hub.storage;
    // hit: served, cited (credited to beta because the record is beta's — must still join back)
    s.insertSession({ id: "hit", projectPath: alpha, agent: "claude-code", source: "t", goal: "use memory", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", alpha, { sessionId: "hit", usedTokens: 400, maxTokens: 600, injectedFixIds: [fixId], servedAgeDays: [12], gated: false });
    s.recordMetric("recall_skipped", alpha, { sessionId: "hit" });
    s.recordMetric("recall_skipped", alpha, { sessionId: "hit" });
    s.recordMetric("recall_cited", beta, { sessionId: "hit", idPrefix: "abcdef", resolved: true, source: "brief" });
    s.recordMetric("session_usage", alpha, { sessionId: "hit", turns: 2, contextTokens: 5000, outputTokens: 100 });
    s.recordMetric("session_usage", alpha, { sessionId: "hit", turns: 4, contextTokens: 9000, outputTokens: 200 }); // running total wins
    // thrash: served three times, never used, re-injected past the normal start + first-prompt pair
    s.insertSession({ id: "thrash", projectPath: alpha, agent: "claude-code", source: "t", goal: "ignore memory", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", alpha, { sessionId: "thrash", usedTokens: 550, maxTokens: 600, injectedResearchIds: ["r1", "r2"], servedAgeDays: [80, 95], gated: false });
    s.recordMetric("recall_injected", alpha, { sessionId: "thrash", usedTokens: 550, maxTokens: 600, injectedResearchIds: ["r1", "r2"], servedAgeDays: [80, 95], gated: false });
    s.recordMetric("recall_injected", alpha, { sessionId: "thrash", usedTokens: 550, maxTokens: 600, injectedResearchIds: ["r1", "r2"], servedAgeDays: [80, 95], gated: false });
    s.recordMetric("recall_cited", alpha, { sessionId: "thrash", idPrefix: "zzzzzz", resolved: true, source: "unserved" }); // not a hit
    s.recordMetric("session_usage", alpha, { sessionId: "thrash", turns: 3, contextTokens: 12000, outputTokens: 50 });
    // cold: gated brief, nothing served
    s.insertSession({ id: "cold", projectPath: alpha, agent: "claude-code", source: "t", goal: "active session", dirtyFiles: [], status: "active" });
    s.recordMetric("recall_injected", alpha, { sessionId: "cold", usedTokens: 90, maxTokens: 350, injectedFixIds: [], gated: true, servedAgeDays: [] });
    // silent: session row, hooks never wrote a recall event
    s.insertSession({ id: "silent", projectPath: alpha, agent: "codex", source: "t", goal: "x", dirtyFiles: [], status: "finished" });
    // the hub's own distill job: looks like a session, is not a reader — excluded
    s.insertSession({ id: "distill", projectPath: alpha, agent: "claude-code", source: "t", goal: "You are distilling a coding-agent session transcript into durable memory records.", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", alpha, { sessionId: "distill", usedTokens: 500, maxTokens: 600, injectedResearchIds: ["r1"], servedAgeDays: [5], gated: false });
    s.recordMetric("recall_injected", alpha, { sessionId: "distill", usedTokens: 500, maxTokens: 600, injectedResearchIds: ["r1"], servedAgeDays: [5], gated: false });
    // legacy unkeyed injection on beta, counted but unattributed
    s.recordMetric("recall_injected", beta, { usedTokens: 200, maxTokens: 600 });

    const report = computeRecallEconomics(hub.storage, {});
    const byId = Object.fromEntries(report.sessions.map((row) => [row.sessionId, row]));
    assert.equal(byId.hit.verdict, "hit");
    assert.equal(byId.hit.cited, 1);
    assert.equal(byId.hit.briefsSkipped, 2);
    assert.equal(byId.hit.usage.contextTokens, 9000);
    assert.equal(byId.hit.medianServedAgeDays, 12);
    assert.equal(byId.thrash.verdict, "thrash");
    assert.equal(byId.thrash.citedUnserved, 1);
    assert.equal(byId.thrash.medianServedAgeDays, 88);
    assert.equal(byId.cold.verdict, "cold");
    assert.equal(byId.cold.briefsGated, 1);
    assert.equal(byId.silent.verdict, "silent");
    assert.equal(byId.distill, undefined);
    assert.equal(report.totals.distillExcluded, 1);

    const alphaRow = report.projects.find((p) => p.name === "Alpha");
    assert.equal(alphaRow.sessions, 4);
    assert.deepEqual([alphaRow.hit, alphaRow.cold, alphaRow.thrash, alphaRow.quiet, alphaRow.silent], [1, 1, 1, 0, 1]);
    assert.equal(alphaRow.hitRatePct, 50); // 1 of the 2 sessions memory was served to
    assert.equal(alphaRow.tokensInjected, 400 + 1650 + 90);
    assert.equal(alphaRow.tokensWasted, 1650);
    assert.equal(alphaRow.tokensOnHits, 400);
    assert.equal(alphaRow.skipRatePct, 29); // 2 skipped of 7 prompts
    assert.equal(alphaRow.medianServedAgeDays, 80);
    assert.equal(alphaRow.usage.sessionsWithUsage, 2);
    assert.equal(alphaRow.usage.hubSharePct, Math.round(((400 + 1650) / 21000) * 1000) / 10);
    assert.equal(alphaRow.usage.avgContextHit, 9000);
    assert.equal(alphaRow.usage.avgContextMiss, 12000);
    // worst waste sorts first
    assert.equal(report.projects[0].name, "Alpha");
    const betaRow = report.projects.find((p) => p.name === "Beta");
    assert.equal(betaRow.sessions, 0);
    assert.equal(betaRow.unkeyedInjections, 1);
    assert.equal(betaRow.tokensInjected, 200);
    assert.equal(report.totals.sessions, 4);
    assert.equal(report.totals.tokensWasted, 1650);

    // project scope keeps the cross-project citation join
    const scoped = computeRecallEconomics(hub.storage, { projectPath: alpha });
    assert.equal(scoped.projects.length, 1);
    assert.equal(scoped.sessions.find((row) => row.sessionId === "hit").verdict, "hit");

    // a citation made by another project's session must not leak into this scope
    s.insertSession({ id: "beta-hit", projectPath: beta, agent: "claude-code", source: "t", goal: "beta work", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", beta, { sessionId: "beta-hit", usedTokens: 300, maxTokens: 600, injectedFixIds: [fixId], gated: false });
    s.recordMetric("recall_cited", beta, { sessionId: "beta-hit", idPrefix: "abcdef", resolved: true, source: "brief" });
    const rescoped = computeRecallEconomics(hub.storage, { projectPath: alpha });
    assert.deepEqual(rescoped.projects.map((p) => p.name), ["Alpha"]);
    assert.equal(rescoped.sessions.some((row) => row.sessionId === "beta-hit"), false);
    assert.equal(rescoped.totals.hit, 1);

    // the reciprocal case: a beta session cites an ALPHA-owned record, so the citation is
    // stored under alpha. It is still beta's session and must not become an alpha hit.
    s.insertSession({ id: "beta-cites-alpha", projectPath: beta, agent: "claude-code", source: "t", goal: "beta again", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", beta, { sessionId: "beta-cites-alpha", usedTokens: 300, maxTokens: 600, injectedFixIds: ["a1"], gated: false });
    s.recordMetric("recall_cited", alpha, { sessionId: "beta-cites-alpha", idPrefix: "a1a1a1", resolved: true, source: "brief" });
    const reciprocal = computeRecallEconomics(hub.storage, { projectPath: alpha });
    assert.equal(reciprocal.sessions.some((row) => row.sessionId === "beta-cites-alpha"), false);
    assert.equal(reciprocal.totals.hit, 1);
    // unscoped, the session is credited where it ran
    const everywhere = computeRecallEconomics(hub.storage, {});
    assert.equal(everywhere.sessions.find((row) => row.sessionId === "beta-cites-alpha").projectPath, hub.storage.listProjectProfiles().find((p) => p.name === "Beta").projectPath);

    // file-overlap usefulness credits its session: by its own session id, or, for rows
    // written before that was recorded, through the injection metric it points at
    s.insertSession({ id: "useful-new", projectPath: alpha, agent: "claude-code", source: "t", goal: "fix x", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", alpha, { sessionId: "useful-new", usedTokens: 100, maxTokens: 600, injectedFixIds: [fixId], gated: false });
    s.recordMetric("recall_useful", alpha, { sessionId: "useful-new", fixId: "n" });
    s.insertSession({ id: "useful-old", projectPath: alpha, agent: "claude-code", source: "t", goal: "fix y", dirtyFiles: [], status: "finished" });
    s.recordMetric("recall_injected", alpha, { sessionId: "useful-old", usedTokens: 100, maxTokens: 600, injectedFixIds: [fixId], gated: false });
    const injection = s.listMetrics(alpha, { kind: "recall_injected", limit: 1 })[0];
    s.recordMetric("recall_useful", alpha, { fixId: "o", recallMetricId: injection.id });
    const useful = Object.fromEntries(computeRecallEconomics(hub.storage, {}).sessions.map((row) => [row.sessionId, row]));
    assert.equal(useful["useful-new"].verdict, "hit");
    assert.equal(useful["useful-old"].verdict, "hit");

    const text = renderRecallEconomicsText(report);
    assert.match(text, /Sessions 4: hit 1 · cold 1 · thrash 1/);
    assert.match(text, /Alpha\s+4\s+1\s+1\s+1\s+0\s+50%/);
    assert.match(text, /thrash/);
  });
});

test("GET /api/v1/recall-economics serves the portfolio, a project scope, and rejects a bad window", async () => {
  await withHub(async (hub, dir) => {
    hub.upsertProjectProfile({ projectPath: dir, name: "Econ", mode: "general", summary: "" });
    hub.storage.insertSession({ id: "s1", projectPath: dir, agent: "claude-code", source: "t", goal: "g", dirtyFiles: [], status: "active" });
    hub.storage.recordMetric("recall_injected", dir, { sessionId: "s1", usedTokens: 100, maxTokens: 600, injectedFixIds: ["f"], gated: false });
    const staticDir = join(dir, "dist");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
    const server = createCortexServer({ hub, staticDir });
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    try {
      const all = await (await fetch(`${base}/recall-economics?since=7d`)).json();
      assert.equal(all.projectPath, null);
      assert.equal(all.totals.sessions, 1);
      assert.equal(all.sessions[0].verdict, "quiet");
      const scoped = await (await fetch(`${base}/recall-economics?project=${encodeURIComponent(dir)}`)).json();
      assert.equal(scoped.projects.length, 1);
      const bad = await fetch(`${base}/recall-economics?since=banana`);
      assert.equal(bad.status, 400);
    } finally {
      await server.stop();
    }
  });
});
