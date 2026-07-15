// The 2026-07 "memory flaws" fixes: stale-correction verb, machine-wide lessons,
// last-session surfacing, transcript distillation, and just-in-time file recall.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCortex } from "../src/index.js";
import { transcriptAssistantTexts, sampleTranscript, parseDistilledRecords, runNextDistillJob } from "../src/distill.js";
import { buildJitNote } from "../src/jit-recall.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-loops-"));
  const hub = createCortex({ dbPath: join(dir, "loops.sqlite") });
  hub.upsertProjectProfile({ projectPath: dir, name: "Test", mode: "general", summary: "" });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

const seedFix = (hub, dir, summary, file = "src/gate.js") => hub.captureCandidate({
  projectPath: dir, agent: "a",
  message: `${summary}. Files changed: ${file}. Verification: npm test passed.`,
});

// ---- fix #3: Stale: [m:xxxxxx] corrections quarantine records out of briefs ----

test("Stale: correction quarantines the record, removes it from briefs, and records the metric", async () => {
  await withHub(async (hub, dir) => {
    const fix = seedFix(hub, dir, "Fixed the retry race in the gate");
    const prefix = fix.recordId.replace(/-/g, "").slice(0, 6);
    assert.match(hub.buildBrief({ projectPath: dir }).text, /retry race/);

    const result = hub.captureCandidate({
      projectPath: dir, agent: "b",
      message: `Investigated the gate again. The old note is wrong. Stale: [m:${prefix}] retry race was actually fixed upstream; this advice misleads.`,
    });
    assert.notEqual(result.action, "error");
    assert.equal(hub.storage.getFix(fix.recordId).qualityStatus, "quarantined");
    // gone from the Recent Fixes slots (the correction message itself may echo the phrase
    // elsewhere in the brief, e.g. as the last-session line — that's fine)
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /Recent Fixes:[\s\S]*?retry race/);

    const contradicted = hub.storage.listMetrics(dir, { kind: "recall_contradicted" });
    assert.equal(contradicted.length, 1);
    assert.equal(contradicted[0].payload.idPrefix, prefix);
    assert.equal(contradicted[0].payload.quarantined, "fix");
    // a staled id is a correction, not a use — it must not count as a citation
    const cited = hub.storage.listMetrics(dir, { kind: "recall_cited" })
      .filter((m) => m.payload.idPrefix === prefix);
    assert.equal(cited.length, 0);
  });
});

test("brief footer teaches the Stale: verb", async () => {
  await withHub(async (hub, dir) => {
    assert.match(hub.buildBrief({ projectPath: dir }).text, /Stale: \[m:xxxxxx\]/);
  });
});

// ---- fix #4: machine-wide lessons surface in every project's brief ----

test("a 'machine'-scoped lesson appears in every registered project's brief", async () => {
  await withHub(async (hub, dir) => {
    hub.addLesson({ projectPath: "machine", lesson: "claude CLI OAuth expiry breaks headless runs; only an interactive /login recovers." });
    const brief = hub.buildBrief({ projectPath: dir });
    assert.match(brief.text, /Machine-wide Lessons:/);
    assert.match(brief.text, /OAuth expiry breaks headless runs/);
    // the reserved scope is stored literally, never resolved against cwd
    assert.equal(hub.storage.listLessons("machine").length, 1);
  });
});

test("no Machine-wide Lessons section when none exist (no permanent noise line)", async () => {
  await withHub(async (hub, dir) => {
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /Machine-wide Lessons:/);
  });
});

// ---- fix #6: the demoted tier is no longer write-only ----

test("the newest unevidenced session event surfaces as 'Last session' in the next brief", async () => {
  await withHub(async (hub, dir) => {
    const demoted = hub.captureCandidate({
      projectPath: dir, agent: "a",
      message: "Implemented the export flow end to end and it looked right in manual testing.",
    });
    assert.equal(demoted.reason, "stored_session_event");
    assert.match(hub.buildBrief({ projectPath: dir }).text, /Last session \(unevidenced\): Implemented the export flow/);
  });
});

test("an explicit handoff wins over the last-session line", async () => {
  await withHub(async (hub, dir) => {
    hub.captureCandidate({ projectPath: dir, agent: "a", message: "Implemented the export flow end to end and it looked right in manual testing." });
    hub.captureCandidate({ projectPath: dir, agent: "a", message: "Handoff: resume at the export validator; two cases left." });
    const text = hub.buildBrief({ projectPath: dir }).text;
    assert.match(text, /Handoff \(picking up from last session\): resume at the export validator/);
    assert.doesNotMatch(text, /Last session \(unevidenced\)/);
  });
});

// ---- fix #1: transcript distillation ----

const transcriptLine = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

test("transcriptAssistantTexts extracts assistant turns; sampleTranscript keeps head and tail", () => {
  const texts = ["first turn", "middle", "final conclusions"];
  const joined = sampleTranscript(texts, 10_000);
  assert.match(joined, /first turn/);
  assert.match(joined, /final conclusions/);
  const trimmed = sampleTranscript(Array.from({ length: 200 }, (_, i) => `turn number ${i} with padding text`), 2000);
  assert.equal(trimmed.length <= 2100, true);
  assert.match(trimmed, /transcript trimmed/);
  assert.match(trimmed, /turn number 199/);
});

test("parseDistilledRecords splits on === and honors NOTHING", () => {
  assert.deepEqual(parseDistilledRecords("NOTHING"), []);
  const records = parseDistilledRecords(
    "Fixed the cache stampede root cause in the loader. Files changed: src/loader.js. Verification: load test passed.\n===\nDecision: use per-key locks. Rationale: global lock serialized all reads. Alternatives: request coalescing.",
  );
  assert.equal(records.length, 2);
  assert.match(records[0], /cache stampede/);
  assert.match(records[1], /^Decision:/);
});

function fakeDistillModel(output) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit("close", 143);
    setImmediate(() => { child.stdout.end(output); child.emit("close", 0); });
    return child;
  };
}

test("a Stop capture with a transcript enqueues distillation; the drain stores gated records", async () => {
  await withHub(async (hub, dir) => {
    const transcript = join(dir, "t.jsonl");
    await writeFile(transcript, Array.from({ length: 12 }, (_, i) => transcriptLine(`assistant turn ${i}`)).join("\n"));

    hub.captureCandidate({
      projectPath: dir, agent: "claude-code", source: "claude-stop-hook",
      message: "Wrapped up for today.", transcriptPath: transcript,
    });
    assert.ok(hub.storage.nextDistillJob(), "capture with transcriptPath enqueues a job");

    const status = await runNextDistillJob(hub, {
      spawnImpl: fakeDistillModel(
        "Fixed the loader stampede: cache misses fanned out unbounded. Files changed: src/loader.js. Verification: load test passed.\n===\nQuestion: why did retries loop forever? Finding: the backoff cap was never applied on the error path.",
      ),
    });
    assert.equal(status, "done:2");
    assert.equal(hub.storage.nextDistillJob(), null, "queue drained");
    assert.equal(hub.storage.listFixes(dir).some((f) => /loader stampede/.test(f.summary)), true);
    assert.equal(hub.storage.listResearch(dir).some((r) => /backoff cap/.test(r.finding)), true);
    // distilled captures carry source "distill" and no transcriptPath — nothing re-enqueued
  });
});

test("short transcripts are skipped without a model call", async () => {
  await withHub(async (hub, dir) => {
    const transcript = join(dir, "short.jsonl");
    await writeFile(transcript, [transcriptLine("only"), transcriptLine("three"), transcriptLine("turns")].join("\n"));
    hub.storage.enqueueDistillJob({ projectPath: dir, transcriptPath: transcript, agent: "a" });
    const status = await runNextDistillJob(hub, {
      spawnImpl: () => { throw new Error("model must not be spawned for a short transcript"); },
    });
    assert.equal(status, "skipped_short");
  });
});

test("distillation can be disabled and never enqueues twice for one transcript", async () => {
  await withHub(async (hub, dir) => {
    const transcript = join(dir, "t2.jsonl");
    await writeFile(transcript, transcriptLine("x"));
    hub.storage.setSetting("distill.enabled", false);
    hub.captureCandidate({ projectPath: dir, agent: "a", source: "claude-stop-hook", message: "Done for now.", transcriptPath: transcript });
    assert.equal(hub.storage.nextDistillJob(), null);

    hub.storage.setSetting("distill.enabled", true);
    const first = hub.storage.enqueueDistillJob({ projectPath: dir, transcriptPath: transcript, agent: "a" });
    const second = hub.storage.enqueueDistillJob({ projectPath: dir, transcriptPath: transcript, agent: "a" });
    assert.equal(second.deduped, true);
    assert.equal(second.id, first.id);
  });
});

// ---- fix #5: just-in-time file-triggered recall ----

test("JIT note fires once per session for a repeat-offender file, with a citable id", async () => {
  await withHub(async (hub, dir) => {
    seedFix(hub, dir, "Fixed ordering bug in the gate");
    seedFix(hub, dir, "Corrected overflow handling in validation");
    const note = buildJitNote(hub.storage, { projectPath: dir, filePath: "deep/nested/gate.js", sessionId: "s-1" });
    assert.match(note, /editing gate\.js: 2 prior fix/);
    assert.match(note, /\[m:[0-9a-f]{6}\]/);
    // same session, same file: silent the second time
    assert.equal(buildJitNote(hub.storage, { projectPath: dir, filePath: "src/gate.js", sessionId: "s-1" }), null);
    // a NEW session gets the note again
    assert.match(buildJitNote(hub.storage, { projectPath: dir, filePath: "src/gate.js", sessionId: "s-2" }), /2 prior fix/);
  });
});

test("JIT note stays silent below the threshold, for unregistered projects, and for quarantined history", async () => {
  await withHub(async (hub, dir) => {
    const only = seedFix(hub, dir, "Fixed a one-off typo in the gate");
    assert.equal(buildJitNote(hub.storage, { projectPath: dir, filePath: "src/gate.js", sessionId: "s-1" }), null, "one fix is below the threshold");

    const second = seedFix(hub, dir, "Corrected overflow handling in validation");
    hub.storage.quarantineRecordByPrefix(dir, only.recordId.replace(/-/g, "").slice(0, 6));
    hub.storage.quarantineRecordByPrefix(dir, second.recordId.replace(/-/g, "").slice(0, 6));
    assert.equal(buildJitNote(hub.storage, { projectPath: dir, filePath: "src/gate.js", sessionId: "s-1" }), null, "quarantined fixes don't count");

    assert.equal(buildJitNote(hub.storage, { projectPath: "C:/not/registered", filePath: "src/gate.js", sessionId: "s-1" }), null);
  });
});

test("a lesson naming the file triggers the JIT note even with few fixes", async () => {
  await withHub(async (hub, dir) => {
    hub.addLesson({ projectPath: dir, lesson: "gate.js ordering is fragile — always run the full suite after touching it." });
    const note = buildJitNote(hub.storage, { projectPath: dir, filePath: "src/gate.js", sessionId: "s-1" });
    assert.match(note, /Lesson: gate\.js ordering is fragile/);
  });
});
