import { createHash, randomUUID } from "node:crypto";
import { classifyCandidate, normalizeCandidate, isNearDuplicate } from "./capturePolicy.js";
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
    const matchedFixIds = (perRecord || [])
      .filter((f) => (f.filesChanged || []).some((file) => wanted.has(String(file).toLowerCase())))
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

const LESSON_PROMOTION_THRESHOLD = Number(process.env.CORTEX_LESSON_PROMOTION_THRESHOLD || 3);
const LESSON_WINDOW_DAYS = Number(process.env.CORTEX_LESSON_WINDOW_DAYS || 30);

// A file that keeps accumulating fixes IS the recurring pattern — promote it to a lesson
// directly from fix history. (The old promoter keyed off near-duplicate discards, which
// never fired in 22 days of live capture, so no lesson was ever promoted.)
function promoteFragileFileLesson(storage, projectPath, agent, filesChanged) {
  try {
    const bases = [...new Set((filesChanged || []).map(fileBase).filter(Boolean))];
    if (!bases.length) return;
    const since = Date.now() - LESSON_WINDOW_DAYS * 86_400_000;
    const recent = storage.listFixes(projectPath, { limit: 200 })
      .filter((fix) => new Date(fix.createdAt).getTime() >= since);
    const lessons = storage.listLessons(projectPath, { limit: 100 });
    for (const base of bases) {
      const hits = recent.filter((fix) => (fix.filesChanged || []).some((f) => fileBase(f) === base));
      if (hits.length < LESSON_PROMOTION_THRESHOLD) continue;
      if (lessons.some((l) => String(l.statement || "").toLowerCase().includes(base))) continue;
      storage.insertLesson({
        projectPath,
        statement: `Fragile file: ${base} — ${hits.length} fixes in ${LESSON_WINDOW_DAYS} days; latest: ${hits[0].summary?.slice(0, 120)}`,
        status: "learned",
      });
      storage.recordMetric("lesson_promoted", projectPath, { agent, file: base, hits: hits.length });
    }
  } catch {
    // telemetry/promotion must never block capture
  }
}

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
        { signature: `${classification.fields.question} ${classification.fields.finding}`, verification: classification.fields.verification },
        recent.map((record) => ({
          id: record.id,
          signature: `${record.question} ${record.finding}`,
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
      if (isFix) promoteFragileFileLesson(storage, candidate.projectPath, candidate.agent, classification.fields.filesChanged);
      return { action: "discarded", reason: "discarded_near_duplicate", recordType: classification.type, recordId: dup.existingId };
    }
  }

  if (classification.type === "task_update") {
    const task = storage.getTask(classification.taskId);
    if (!task || task.projectPath !== candidate.projectPath) {
      return { action: "discarded", reason: "discarded_unknown_task", recordType: "task_update", recordId: null };
    }
    storage.updateTask(task.id, {
      status: classification.status,
      blockReason: classification.status === "blocked" ? classification.detail || "blocked" : null,
      evidence: classification.status === "done" ? classification.detail || "completed" : task.evidence,
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
    promoteFragileFileLesson(storage, candidate.projectPath, candidate.agent, fields.filesChanged);
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
    const recent = storage.listDecisions(candidate.projectPath, { limit: 50, excludeSuperseded: true });
    const signature = `${fields.decision} ${fields.rationale} ${fields.alternatives || ""}`;
    const dup = isNearDuplicate(
      { signature },
      recent.map((d) => ({ id: d.id, signature: `${d.decision} ${d.rationale} ${d.alternatives || ""}` })),
      { threshold: DEDUP_THRESHOLD },
    );
    if (dup?.duplicate) {
      return { action: "discarded", reason: "discarded_near_duplicate", recordType: "decision", recordId: dup.existingId };
    }
    const record = storage.transaction(() => {
      const inserted = storage.insertDecision({
        id: randomUUID(), projectPath: candidate.projectPath, agent: candidate.agent,
        decision: fields.decision, rationale: fields.rationale, alternatives: fields.alternatives,
        captureSource: candidate.source, qualityStatus: "accepted", fingerprint: hash,
      });
      linkCapturedRecord(storage, inserted, "decision");
      enqueueRecord(storage, inserted.id, "decision");
      return inserted;
    });
    return { action: "accepted", reason: "accepted_decision", recordType: "decision", recordId: record.id };
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
      storage.recordMetric("recall_cited", candidate.projectPath, { agent: candidate.agent, idPrefix });
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
