import { createHash, randomUUID } from "node:crypto";
import { classifyCandidate, normalizeCandidate, isNearDuplicate, keyTokens, containment } from "./capturePolicy.js";
import { linkCapturedRecord } from "./linker.js";
import { enqueueRecord } from "./indexer.js";
import { LocalMinHashEmbeddingProvider } from "./embeddingProvider.js";

// Token-overlap-only dedup stays for research/decisions (no file anchor to use). For fixes,
// the 0.82 jaccard gate never fired once in 22 days of live capture — replaced below by
// entity-anchored dedup (shared changed file + moderate text similarity), which can separate
// "same fix rephrased" from "different bug in a sibling file" the way raw token overlap can't.
const DEDUP_THRESHOLD = Number(process.env.CORTEX_DEDUP_THRESHOLD || 0.82);
// Measured anchors (MinHash on this provider): same fix restated = 1.0, near-paraphrase with
// one entity word swapped = 0.8, genuinely new work on the same file (supersede case) = 0.6.
// 0.7 sits between "restated" and "new work"; tune only with new measured pairs.
const FIX_DEDUP_SIMILARITY = Number(process.env.CORTEX_FIX_DEDUP_SIMILARITY || 0.7);

const minhash = new LocalMinHashEmbeddingProvider();

const fileBase = (f) => String(f || "").toLowerCase().replaceAll("\\", "/").split("/").pop();

// Same changed file AND moderately similar summary = the same fix resurfacing.
// Different files stay distinct even at high text overlap (login form vs signup form).
export function findFixDuplicate(fields, recentFixes, { threshold = FIX_DEDUP_SIMILARITY } = {}) {
  const files = new Set((fields.filesChanged || []).map(fileBase).filter(Boolean));
  if (!files.size) return null;
  let best = null;
  for (const fix of recentFixes) {
    if (!(fix.filesChanged || []).some((f) => files.has(fileBase(f)))) continue;
    const similarity = minhash.similarity(fields.summary || "", fix.summary || "");
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = {
        duplicate: true,
        existingId: fix.id,
        similarity,
        existingVerified: Boolean(fix.verification) || fix.qualityStatus === "verified",
      };
    }
  }
  return best;
}

// Distillation paraphrases the same decision differently per transcript, so the 0.82
// token-overlap gate let reworded duplicates through — one decision landed three times in
// 3.3 days of live data (value audit II). MinHash catches rewording the way it does for
// fixes; decisions have no file anchor, so text similarity over decision+rationale is the
// whole test. Threshold shares the fixes' measured anchors — tune only with measured pairs.
const DECISION_DEDUP_SIMILARITY = Number(process.env.CORTEX_DECISION_DEDUP_SIMILARITY || 0.7);

// The 0.7 full-text gate misses restatements whose rationale is freshly worded: 133 of 630 live
// decisions (21%) were restatements of another, almost all from the same session's repeated
// flushes (measured 2026-08-03). The choice sentence is the stable anchor — live dupe pairs
// measure 0.7–1.0 headline containment (94% at >=0.8) while random same-project pairs sit at
// 0.0–0.3 (2 of 747 above 0.7). A headline match below the full-text gate is a REVISION, not a
// duplicate: the caller inserts it with supersedesId so the newest wording stays live and the
// prior drops to history. A reversal ("A over B" -> "B over A") lands here too — token measures
// cannot see the flip, and superseding is the correct outcome for it anyway.
const DECISION_HEADLINE_CONTAINMENT = Number(process.env.CORTEX_DECISION_HEADLINE_CONTAINMENT || 0.8);

export function findDecisionDuplicate(fields, recentDecisions, {
  threshold = DECISION_DEDUP_SIMILARITY,
  headlineThreshold = DECISION_HEADLINE_CONTAINMENT,
} = {}) {
  const text = `${fields.decision} ${fields.rationale} ${fields.alternatives || ""}`;
  const headline = keyTokens(fields.decision);
  let best = null;
  let revision = null;
  for (const decision of recentDecisions) {
    const similarity = minhash.similarity(text, `${decision.decision} ${decision.rationale} ${decision.alternatives || ""}`);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { duplicate: true, existingId: decision.id, similarity };
    }
    const overlap = containment(headline, keyTokens(decision.decision));
    if (overlap >= headlineThreshold && (!revision || overlap > revision.headlineOverlap)) {
      revision = { revision: true, existingId: decision.id, headlineOverlap: overlap };
    }
  }
  return best || revision;
}

function fingerprint(candidate, classification) {
  const f = classification.fields || {};
  // decisions dedup on full decision+rationale+alternatives, not the choice text alone
  const body = classification.type === "decision"
    ? `${f.decision}${f.rationale}${f.alternatives || ""}`
    : (f.summary || candidate.message);
  // projectPath is kept out of the lowercased content: normalizeProjectPath already makes it
  // the canonical identity, and blanket-lowercasing would fingerprint-collide two genuinely
  // distinct, case-sensitive directories on Linux/macOS (e.g. .../ProjectA vs .../projecta),
  // silently deduping one project's captures against another's.
  const content = [
    classification.type,
    body,
    classification.taskId || "",
    f.commitSha || candidate.commitSha || "",
  ].join("").toLowerCase();
  return createHash("sha256").update(`${candidate.projectPath}${content}`).digest("hex");
}

function expiresInDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const RECALL_USEFUL_WINDOW_HOURS = Number(process.env.CORTEX_RECALL_USEFUL_WINDOW_HOURS || 24);
const RECALL_USEFUL_MAX_FILES = Number(process.env.CORTEX_RECALL_USEFUL_MAX_FILES || 2);

// A recall "worked" when a fix lands on a file the most recent brief actually surfaced
// to the agent — measures whether injected memory gets used, not just injected.
// Any overlap with the flat injectedFilesChanged union over-fired: fragile files show up
// in every brief, so every fix touching one looked like a successful recall. Count it
// useful only when the overlap points at exactly one recalled record; legacy payloads
// without per-record data fall back to requiring a narrow matched-file set.
function recordRecallUsefulness(storage, projectPath, agent, fixId, filesChanged) {
  if (!filesChanged?.length) return;
  try {
    const since = new Date(Date.now() - RECALL_USEFUL_WINDOW_HOURS * 3600000).toISOString();
    const recent = storage.listMetrics(projectPath, { kind: "recall_injected", since, limit: 1 })[0];
    const injected = recent?.payload?.injectedFilesChanged || [];
    if (!injected.length) return;
    const wanted = new Set(filesChanged.map((file) => String(file).toLowerCase()));
    const matchedFiles = injected.filter((file) => wanted.has(String(file).toLowerCase()));
    if (!matchedFiles.length) return;
    const perRecord = recent.payload.injectedFixes;
    // Project-scoped (audit III): a fix injected from another project must not count as useful
    // recall here — relative paths like Core/Foo.swift collide across repos (a sleep-app path
    // stored under a hub session matched a hub capture), inflating the honest-usefulness metric
    // the Aug-17 kill decision reads. Cross-project reuse is credited by explicit citations
    // (recall_cited), not this file-overlap heuristic. Legacy payloads lack projectPath -> allow.
    // Separator-insensitive compare: canonicalizeProjectPath'd rows use "/" but older payloads
    // (and hand-written ones) may hold "\\" — see storage.js normalizeProjectPath.
    const sameProject = (a) => a == null
      || String(a).replaceAll("\\", "/").toLowerCase() === String(projectPath).replaceAll("\\", "/").toLowerCase();
    const matchedFixIds = (perRecord || [])
      .filter((f) => sameProject(f.projectPath)
        && (f.filesChanged || []).some((file) => wanted.has(String(file).toLowerCase())))
      .map((f) => f.id);
    const narrow = perRecord
      ? matchedFixIds.length === 1
      : matchedFiles.length <= RECALL_USEFUL_MAX_FILES;
    if (!narrow) return;
    storage.recordMetric("recall_useful", projectPath, { agent, fixId, matchedFiles, matchedFixIds, recallMetricId: recent.id });
  } catch {
    // telemetry must never block capture
  }
}

// The fragile-file lesson generator is gone. It was the ONLY lesson template, produced 83
// rows, and not one was ever cited. Worse, its count was wrong: it counted fix RECORDS, which
// duplicate captures inflate 2-6x against git — SETUP.md read as 92 fixes where the repo has
// 14 commits, server.js 89 against 42. A number that overstates churn sixfold, attached to a
// lesson nobody reads, is not a lesson. The lessons table stays: agents and humans still write
// real ones through the API, and JIT recall still serves them.

function admitCandidate(storage, candidate) {
  const classification = classifyCandidate(candidate);
  if (classification.type === "discard") {
    return { action: "discarded", reason: classification.reason, recordType: null, recordId: null };
  }

  const hash = fingerprint(candidate, classification);
  const existing = storage.findCaptureByFingerprint(hash);
  if (existing) {
    return { action: "discarded", reason: "discarded_duplicate", recordType: existing.recordType, recordId: existing.id };
  }

  if (classification.type === "fix" || classification.type === "research") {
    const isFix = classification.type === "fix";
    const recent = isFix
      ? storage.listFixes(candidate.projectPath, { limit: 50 })
      : storage.listResearch(candidate.projectPath, { limit: 50 });
    const dup = isFix
      ? findFixDuplicate(classification.fields, recent)
      : isNearDuplicate(
        {
          signature: `${classification.fields.question} ${classification.fields.finding}`,
          key: classification.fields.question, // compared on its own; a long finding hides an identical question
          verification: classification.fields.verification,
        },
        recent.map((record) => ({
          id: record.id,
          signature: `${record.question} ${record.finding}`,
          key: record.question,
          verification: record.verification,
          qualityStatus: record.qualityStatus,
        })),
        { threshold: DEDUP_THRESHOLD },
      );
    if (dup?.duplicate) {
      if (classification.fields.verification && !dup.existingVerified) {
        storage.setRecordVerification(classification.type, dup.existingId, classification.fields.verification);
        storage.transaction(() => enqueueRecord(storage, dup.existingId, classification.type));
      }
      return { action: "discarded", reason: "discarded_near_duplicate", recordType: classification.type, recordId: dup.existingId };
    }
  }

  if (classification.type === "task_update") {
    const task = storage.getTask(classification.taskId);
    if (!task || task.projectPath !== candidate.projectPath) {
      return { action: "discarded", reason: "discarded_unknown_task", recordType: "task_update", recordId: null };
    }
    // Completion authority: a captured agent narration ("Task X is done: ...") must not silently
    // finish a task behind the human's back — agents park in review for human sign-off. Clamp
    // done->review unless the capture is human-authored. Mirrors the completeTask/editTask guard
    // in commands.js; the completion detail is still preserved as the review evidence.
    const requested = classification.status;
    const clamped = requested === "done" && candidate.agent !== "human";
    const status = clamped ? "review" : requested;
    // PR #29 authority clamp was unmeasured (audit III): count how often an agent tries to
    // self-complete behind the human's back, so the guard's value is visible in stats.
    if (clamped) {
      try { storage.recordMetric("completion_clamped", candidate.projectPath, { taskId: task.id, agent: candidate.agent }); }
      catch { /* observability is best-effort */ }
    }
    storage.updateTask(task.id, {
      status,
      blockReason: status === "blocked" ? classification.detail || "blocked" : null,
      evidence: requested === "done" ? classification.detail || "completed" : task.evidence,
    });
    return { action: "accepted", reason: "accepted_task_update", recordType: "task_update", recordId: task.id };
  }

  const fields = classification.fields;
  if (classification.type === "fix") {
    const record = storage.transaction(() => {
      const prior = fields.verification
        ? storage.findSupersedableFix({ projectPath: candidate.projectPath, filesChanged: fields.filesChanged })
        : null;
      const inserted = storage.insertFix({
        id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
        summary: fields.summary, filesChanged: fields.filesChanged, commitSha: fields.commitSha,
        verification: fields.verification, residualRisk: fields.residualRisk,
        captureSource: candidate.source, qualityStatus: fields.verification ? "verified" : "unverified",
        fingerprint: hash, supersedesId: prior?.id || null,
      });
      const recordEntity = linkCapturedRecord(storage, inserted, "fix");
      if (prior) {
        const priorEntity = storage.upsertEntity({
          entityType: "record", canonicalKey: `fix:${prior.id}`, label: prior.summary,
          projectPath: prior.projectPath, metadata: { recordId: prior.id, recordType: "fix" },
        });
        storage.linkRecords({
          fromEntityId: recordEntity.id, toEntityId: priorEntity.id,
          linkType: "supersedes", source: "deterministic", confidence: 1, originRecordId: inserted.id,
        });
      }
      enqueueRecord(storage, inserted.id, "fix");
      return inserted;
    });
    recordRecallUsefulness(storage, candidate.projectPath, candidate.agent, record.id, fields.filesChanged);
    return { action: "accepted", reason: "accepted_fix", recordType: "fix", recordId: record.id };
  }

  if (classification.type === "research") {
    const record = storage.transaction(() => {
      const inserted = storage.insertResearch({
        id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
        question: fields.question, finding: fields.finding, sources: [], evidence: [], reuseTags: [],
        verification: fields.verification, residualRisk: fields.residualRisk,
        captureSource: candidate.source, qualityStatus: fields.verification ? "verified" : "unverified",
        fingerprint: hash,
      });
      linkCapturedRecord(storage, inserted, "research");
      enqueueRecord(storage, inserted.id, "research");
      return inserted;
    });
    return { action: "accepted", reason: "accepted_research", recordType: "research", recordId: record.id };
  }

  if (classification.type === "decision") {
    // An explicit "Supersedes: [m:xxxxxx]" marker outranks similarity detection: the agent is
    // declaring a reversal of a decision it was served, so the duplicate gate is skipped —
    // a reversal that reads like its predecessor is still a new decision.
    const marked = supersededDecisionFromMarker(storage, candidate);
    let prior = marked;
    if (!marked) {
      const recent = storage.listDecisions(candidate.projectPath, { limit: 50, excludeSuperseded: true });
      const dup = findDecisionDuplicate(fields, recent);
      if (dup?.duplicate) {
        return { action: "discarded", reason: "discarded_near_duplicate", recordType: "decision", recordId: dup.existingId };
      }
      prior = dup?.revision ? recent.find((d) => d.id === dup.existingId) : null;
    }
    const record = storage.transaction(() => {
      const inserted = storage.insertDecision({
        id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
        decision: fields.decision, rationale: fields.rationale, alternatives: fields.alternatives,
        captureSource: candidate.source, qualityStatus: "accepted", fingerprint: hash,
        supersedesId: prior?.id || null,
      });
      const recordEntity = linkCapturedRecord(storage, inserted, "decision");
      if (prior) {
        const priorEntity = storage.upsertEntity({
          entityType: "record", canonicalKey: `decision:${prior.id}`, label: prior.decision,
          projectPath: prior.projectPath, metadata: { recordId: prior.id, recordType: "decision" },
        });
        storage.linkRecords({
          fromEntityId: recordEntity.id, toEntityId: priorEntity.id,
          linkType: "supersedes", source: "deterministic", confidence: 1, originRecordId: inserted.id,
        });
      }
      enqueueRecord(storage, inserted.id, "decision");
      return inserted;
    });
    return {
      action: "accepted",
      reason: prior ? "accepted_decision_revision" : "accepted_decision",
      recordType: "decision", recordId: record.id,
    };
  }

  if (classification.type === "handoff") {
    // reuses session_events (no schema change): source carries the branch tag so
    // the next SessionStart on the same branch can find "where I left off" without
    // a new table. Short TTL — a handoff is only useful for the next session or two.
    const record = storage.insertSessionEvent({
      id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
      source: `handoff:${candidate.branch || "unknown"}`, summary: fields.handoff, fingerprint: hash,
      expiresAt: expiresInDays(Number(process.env.CORTEX_HANDOFF_TTL_DAYS || 3)),
    });
    return { action: "accepted", reason: "accepted_handoff", recordType: "session_event", recordId: record.id };
  }

  const record = storage.insertSessionEvent({
    id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
    source: candidate.source, summary: fields.summary, fingerprint: hash,
    expiresAt: expiresInDays(7),
  });
  return { action: "accepted", reason: "stored_session_event", recordType: "session_event", recordId: record.id };
}

// Reversal pointer: the agent writes "Supersedes: [m:xxxxxx]" when its decision contradicts a
// briefed one. Resolving the prefix here is the whole trigger — capture-side text similarity
// never fired (supersedes_id 0/815 in the live DB), but the retrieved set is small and id-tagged.
function supersededDecisionFromMarker(storage, candidate) {
  try {
    const m = candidate.message.match(/\bSupersedes:\s*\[m:([0-9a-f]{4,8})\]/i);
    return m ? storage.findDecisionByPrefix(candidate.projectPath, m[1].toLowerCase()) : null;
  } catch {
    return null; // marker resolution must never block capture
  }
}

// Closed-loop citation: brief items carry [m:xxxxxx] ids (brief.js); when a session's final
// message cites one, record it. Counts feed ranking (used memories rise) and give recall an
// honest usage signal. Recorded even for discarded candidates — citing is orthogonal to capture.
// The negative loop: "Stale: [m:xxxxxx] <why>" quarantines the record out of briefs — a memory
// an agent had to argue with is worse than no memory, so corrections outweigh citations.
function recordCitations(storage, candidate) {
  try {
    const stale = new Map(
      [...candidate.message.matchAll(/\bStale:\s*\[m:([0-9a-f]{4,8})\]\s*([^\n;]{0,160})?/gi)]
        .map((m) => [m[1].toLowerCase(), (m[2] || "").trim()]),
    );
    for (const [idPrefix, reason] of stale) {
      const quarantined = storage.quarantineRecordByPrefix(candidate.projectPath, idPrefix);
      storage.recordMetric("recall_contradicted", candidate.projectPath, {
        agent: candidate.agent, idPrefix, reason, quarantined,
      });
    }
    const cited = [...new Set(
      [...candidate.message.matchAll(/\[m:([0-9a-f]{4,8})\]/gi)].map((m) => m[1].toLowerCase()),
    )].filter((idPrefix) => !stale.has(idPrefix)); // a staled id is a correction, not a use
    for (const idPrefix of cited) {
      // Attribution honesty (injection audit, Aug 28): the old path credited any echoed id to
      // the session's project with no dedup — 17% of live citations belonged to a different
      // project's record, 20% were never served, and 28% were same-session repeats (Stop fires
      // per turn). Together those inflated the citation rate the Aug-31 verdict rests on.
      const record = storage.findRecordByPrefix(idPrefix);
      const creditProject = record?.projectPath || candidate.projectPath;
      if (candidate.sessionId) {
        const already = storage.listMetrics(creditProject, {
          kind: "recall_cited", sessionId: candidate.sessionId, limit: 50,
        }).some((m) => m.payload?.idPrefix === idPrefix);
        if (already) continue;
      }
      // Channel attribution: was this id actually served to this session, and by which rail?
      let source = "unknown"; // no session key or unresolved id — channel can't be determined
      if (candidate.sessionId && record) {
        // serving metrics are written under the SESSION's project, even when the record
        // being cited belongs to another project — look them up there
        const servedByBrief = storage.listMetrics(candidate.projectPath, {
          kind: "recall_injected", sessionId: candidate.sessionId, limit: 100,
        }).some((m) => ["injectedFixIds", "injectedResearchIds", "injectedDecisionIds"]
          .some((key) => (m.payload?.[key] || []).includes(record.id)));
        const servedByJit = !servedByBrief && storage.listMetrics(candidate.projectPath, {
          kind: "jit_recall", sessionId: candidate.sessionId, limit: 100,
        }).some((m) => (m.payload?.servedFixIds || []).includes(record.id));
        source = servedByBrief ? "brief" : servedByJit ? "jit" : "unserved";
      }
      storage.recordMetric("recall_cited", creditProject, {
        agent: candidate.agent, idPrefix, sessionId: candidate.sessionId || null,
        resolved: Boolean(record), recordType: record?.recordType || null, source,
      });
    }
  } catch {
    // telemetry must never block capture
  }
}

export function captureCandidate(storage, input) {
  const candidate = normalizeCandidate(input); // ponytail: normalize once, reuse for admission + telemetry
  recordCitations(storage, candidate);
  const result = admitCandidate(storage, candidate);
  try {
    storage.recordMetric("capture_outcome", candidate.projectPath, {
      action: result.action, reason: result.reason, recordType: result.recordType, recordId: result.recordId,
      agent: candidate.agent, summary: candidate.message.slice(0, 120),
    });
  } catch {
    // telemetry must never block capture
  }
  return result;
}
