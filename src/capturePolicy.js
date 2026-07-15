import { normalizeProjectPath } from "./storage.js";

const LABELS = "Question|Finding|Verification|Residual risk|Files changed|Commit|Decision|Rationale|Alternatives|Handoff";

function labeled(message, label) {
  const pattern = new RegExp(
    `${label}:\\s*(.*?)(?=\\s+(?:${LABELS}):|$)`,
    "i",
  );
  return message.match(pattern)?.[1]?.trim();
}

function trimSummary(message) {
  return message
    .split(/\s+(?:Files changed|Commit|Verification|Residual risk|Decision|Rationale|Alternatives):/i)[0]
    .trim()
    .slice(0, 500);
}

export function normalizeCandidate(input = {}) {
  return {
    projectPath: normalizeProjectPath(input.projectPath),
    agent: String(input.agent || "unknown").trim(),
    source: String(input.source || "unknown").trim(),
    eventType: String(input.eventType || "message").trim(),
    // node:sqlite truncates TEXT at the first NUL byte silently — strip before it can happen.
    message: String(input.message || "").replace(/\0/g, "").replace(/\s+/g, " ").trim(),
    branch: input.branch || null,
    recentFiles: [...new Set(input.recentFiles || [])],
    commitSha: input.commitSha || null,
  };
}

export function extractCaptureFields(candidate) {
  const { message } = candidate;
  const files = labeled(message, "Files changed")
    ?.split(",")
    .map((file) => file.trim().replace(/[.;]$/, ""))
    .filter(Boolean) || candidate.recentFiles;
  return {
    summary: trimSummary(message),
    question: labeled(message, "Question"),
    finding: labeled(message, "Finding"),
    verification: labeled(message, "Verification"),
    residualRisk: labeled(message, "Residual risk"),
    filesChanged: files,
    commitSha: labeled(message, "Commit")?.replace(/[.;]$/, "") || candidate.commitSha,
    decision: labeled(message, "Decision"),
    rationale: labeled(message, "Rationale"),
    alternatives: labeled(message, "Alternatives"),
    handoff: labeled(message, "Handoff"),
  };
}

// Memory-poisoning quarantine: a session manipulated into echoing instruction-shaped text
// must not persist it into a store that gets re-injected into every future session.
// Patterns are deliberately narrow (literal override phrasing), so security *discussions*
// ("we should defend against prompt injection") still capture normally.
const SUSPICIOUS_RE = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|context|rules)|disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|context)|you\s+must\s+now\s+(?:run|execute|send|forward)|new\s+system\s+prompt)\b/i;

export function classifyCandidate(candidate) {
  const message = candidate.message;
  if (!message) return { type: "discard", reason: "discarded_empty" };
  if (SUSPICIOUS_RE.test(message)) return { type: "discard", reason: "quarantined_suspicious" };

  const taskMatch = message.match(
    /^Task\s+([0-9a-f-]{36})\s+is\s+(blocked|done|in[_ ]progress|review|ready)(?::\s*(.+))?$/i,
  );
  if (taskMatch) {
    return {
      type: "task_update",
      taskId: taskMatch[1],
      status: taskMatch[2].toLowerCase().replace(" ", "_"),
      detail: taskMatch[3]?.trim(),
    };
  }

  const fields = extractCaptureFields(candidate);
  // A genuine fix report (English fix-keyword, or a language-agnostic Files-changed+Verification
  // pair for non-English messages) can contain a Decision:/Rationale:-shaped substring nested
  // inside its Verification prose (e.g. "Verification: Decision: skip retries. Rationale: ...").
  // labeled() has no concept of nesting, so without this guard that substring hijacks
  // classification away from "fix" and the fix record (with its verification) is dropped.
  // Vocabulary widened beyond raw bug-fix verbs — real session output routinely reports
  // completed work as "Recommended:", "Built X", "Plan complete:", "Committed", etc.; measured
  // against live capture data, the narrow verb list alone was accepting under 20% of substantive
  // messages.
  const hasFixKeyword = /\b(?:fixed|implemented|resolved|corrected|added|removed|refactored|recommended|recommend|built|created|wrote|written|designed|updated|reconciled|locked|confirmed|recorded|documented|completed|delivered|shipped|deployed|merged|configured)\b/i.test(message);
  const hasFixEvidence = Boolean(labeled(message, "Files changed") && labeled(message, "Verification"));
  const isFixReport = hasFixKeyword || hasFixEvidence;
  // require BOTH the keyword and evidence together to treat a nested Decision:/Rationale: as
  // noise — either signal alone is too weak (a real decision can legitimately reference files
  // or a review as supporting context without being a fix report).
  const nestedInFixReport = hasFixKeyword && hasFixEvidence;

  // an explicit "Handoff:" is a session ending mid-task, stating where to pick back up —
  // highest precedence, same as decision: it's a deliberate label, not inferred from prose.
  if (fields.handoff) return { type: "handoff", fields };
  // decision before research (labeled decisions win) and before low-signal discard, unless a
  // fix report with real evidence is also present — that always wins over a nested label.
  if (fields.decision && fields.rationale && !nestedInFixReport) return { type: "decision", fields };
  if (fields.question && fields.finding) return { type: "research", fields };

  // Real one-line system/tool chatter ("Can you approve the permission dialog?", "Waiting for
  // approval.") is short. A long message that happens to mention "approval" as domain content
  // (e.g. "Waiting for Apple App Review approval") or ends with a trailing follow-up question
  // ("...should I proceed?") is not chatter just because of that one word or character — gate
  // both checks on message length so only genuinely short prompts get caught here.
  const shortChatterLength = Number(process.env.CORTEX_SHORT_CHATTER_LENGTH || 80);
  const isShortMessage = message.length <= shortChatterLength;
  if (
    /^claude code session completed\.?$/i.test(message) ||
    (isShortMessage && /\b(?:approve|approval|permission dialog|queued message)\b/i.test(message)) ||
    (isShortMessage && message.endsWith("?"))
  ) {
    return { type: "discard", reason: "discarded_low_signal" };
  }

  if (/\b(?:holding steady|still rock-steady|monitoring|next wake|nothing changed)\b/i.test(message)) {
    return { type: "session_event", fields };
  }

  // Evidence gate (2026-07 audit): a *permanent* fix record requires real evidence — an
  // explicit Verification: label (the self-report contract), or changed files plus a commit
  // sha. 22 days of live data showed the keyword-only path admitted 97%-unverified prose
  // (and literal garbage like "##"), which then competed for the brief's five fix slots.
  // Keyword-only reports still survive, but as TTL'd session events, not durable memory.
  const hasFiles = Boolean(fields.filesChanged?.length);
  if (fields.verification || (hasFiles && fields.commitSha)) return { type: "fix", fields };

  // Substantive but unevidenced output (fix keyword, or long multi-signal prose) decays as a
  // session event instead of being discarded outright or stored forever.
  const substantialLength = Number(process.env.CORTEX_SUBSTANTIAL_LENGTH || 150);
  const sentenceCount = (message.match(/[.!?](?:\s|$)/g) || []).length;
  const hasContentSignal = sentenceCount >= 2
    || /^[A-Z][\w -]{2,24}:\s/m.test(message)                                   // "Architecture: ..."
    || /(^|\n)\s*(?:[-*•]|\d+[.)])\s/.test(message)                             // bullet / numbered list
    || /`[^`]+`/.test(message)                                                  // inline code
    || /\b[\w-]+\.(?:jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|cs|md|json|css|html|sql|sh|ps1|ya?ml|toml)\b/i.test(message); // file token
  if (isFixReport || (message.length >= substantialLength && hasContentSignal)) {
    return { type: "session_event", fields };
  }

  return { type: "discard", reason: "discarded_low_signal" };
}

function dedupTokens(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function isNearDuplicate(candidate, recentRecords = [], { threshold = 0.82 } = {}) {
  const candidateTokens = dedupTokens(candidate.signature);
  if (!candidateTokens.size) return null;
  let best = null;
  for (const record of recentRecords) {
    const similarity = jaccard(candidateTokens, dedupTokens(record.signature));
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = {
        duplicate: true,
        existingId: record.id,
        similarity,
        existingVerified: Boolean(record.verification) || record.qualityStatus === "verified",
      };
    }
  }
  return best;
}
