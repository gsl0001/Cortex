import { normalizeProjectPath } from "./storage.js";

const LABELS = "Question|Finding|Verification|Residual risk|Files changed|Commit|Decision|Rationale|Alternatives|Handoff";
// Agents write these labels in markdown — "**Files changed:**", "`Verification:`" — because the
// contract is quoted back inside formatted prose. The stop lookahead only recognised bare labels,
// so a decorated "**Verification:**" did not stop the capture and one field swallowed the rest of
// the message: a live record holds ["Verification", "Decision:\". That's why the answer you
// pasted ends…"] as its list of changed files. Allow the decoration on both sides of a label.
const DECOR = "[*_`]{0,2}";

function labeled(message, label) {
  const pattern = new RegExp(
    `${DECOR}${label}${DECOR}:${DECOR}\\s*(.*?)(?=\\s+${DECOR}(?:${LABELS})${DECOR}:|$)`,
    "i",
  );
  return message.match(pattern)?.[1]?.trim();
}

function trimSummary(message) {
  return message
    .split(new RegExp(`\\s+${DECOR}(?:Files changed|Commit|Verification|Residual risk|Decision|Rationale|Alternatives)${DECOR}:`, "i"))[0]
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
    // carried for citation dedup + channel attribution (recordCitations); never stored on records
    sessionId: input.sessionId || null,
  };
}

// A placeholder ("none", "n/a") or markup-mangled token ("agentLauncher.js`") stored as a
// changed file poisons three consumers downstream: the recall_useful matcher (files=["none"]
// counted as a successful recall), fragile-file lesson promotion ("Fragile file: none"), and
// JIT recall lookups. Sanitize once here — the only entry point for parsed file lists.
// Anchored at the start and no longer requiring the whole token to be the placeholder: the live
// store holds "none; the pre-existing `SETUP.md` modification was preserved" as a changed file,
// which the old whole-string match let through — and which then reads as file evidence.
const FILE_PLACEHOLDER_RE = /^(?:none|n\/?a|nil|nothing|no files(?: changed)?|-+|—)(?:[\s;,]|$)/i;
// A path, or a bare filename with an extension. Prose has neither, and a token that begins as a
// path but trails into commentary ("CameraController.swift (line 1008") keeps only its path part.
// The drive-letter branch comes first and is not optional: without it "C:/work/foo.js" matched
// from "work" onward and silently stored a path with the drive cut off.
const PATH_LIKE_RE = /[A-Za-z]:[\\/][A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)*|[A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)+|[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,8}/;

export function sanitizeFileToken(file) {
  const clean = String(file)
    .trim()
    .replace(/^[`'"([{<*]+/, "")
    .replace(/[`'")\]}>.;:,*]+$/, "")
    .trim();
  if (!clean || FILE_PLACEHOLDER_RE.test(clean)) return null;
  // Extract rather than reject: sentences that genuinely name a file still yield the file, while
  // sentences that name none yield nothing instead of becoming a filename.
  return clean.match(PATH_LIKE_RE)?.[0] || null;
}

export function extractCaptureFields(candidate) {
  const { message } = candidate;
  const labeledFiles = labeled(message, "Files changed");
  const files = labeledFiles !== undefined
    ? labeledFiles.split(",").map(sanitizeFileToken).filter(Boolean)
    : candidate.recentFiles;
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
const SUSPICIOUS_RE = /\b(?:(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|your|the\s+system)\s+(?:instructions|context|rules|prompts?)|you\s+must\s+now\s+(?:run|execute|send|forward)|new\s+system\s+prompt|do\s+not\s+(?:tell|inform|alert)\s+the\s+user)\b/i;

// A verification a human could re-run: a quoted command, a known runner, or a flag. Prose like
// "inspected the hook configuration and live recall statistics" reads as diligence but cannot be
// re-checked by anyone later.
const CHECKABLE_VERIFICATION_RE = /`[^`]+`|\b(?:npm|npx|node|pnpm|yarn|bun|git|pytest|python|cargo|go|make|dotnet|swift|xcodebuild|gradle|mvn|curl|psql|sqlite3|docker)\b|--[a-z][\w-]+/i;

// A summary that opens by answering the reader rather than reporting work. Note what is NOT
// here: fix verbs ("Fixed…", "Shipped…", "Added…", "Done. Added…") — those are reports and stay.
// Measured against the live store before adopting: of the 741 fix rows the evidence gate admits
// today, this demotes 3, and all 3 are conversational answers. The blunter alternative (demand a
// re-runnable verification from every fix) demoted 39, including real backtest results whose
// verification was legitimately prose — "3y backtest + live paper validation".
const ANSWER_OPENER_RE = /^(?:yes|no|nope|yep|yeah|correct|honestly|probably|maybe|short answer|tl;?dr|here'?s|here is|both|that'?s|it'?s|you'?re|based on|capability|can you|what'?s|why |sure|i\s+(?:don'?t|do not|can'?t|cannot|reviewed|checked|looked|ran|found|think|see|agree|would|wouldn'?t))\b/i;

// An answer wearing a fix's clothes: opens by addressing the reader, and attaches nothing anyone
// could re-check. Exported because the capture gate only governs new writes — records stored
// before it existed are already fixes and would otherwise hold brief slots indefinitely, so
// commands.buildBrief applies the same test on the read side.
export function isAnswerProse({ summary, filesChanged, commitSha, verification } = {}) {
  // Re-sanitize on read: records captured before the parser was hardened carry prose in
  // filesChanged, and counting that as file evidence is what let answers keep their fix slots.
  const realFiles = (filesChanged || []).map(sanitizeFileToken).filter(Boolean);
  const evidenced = realFiles.length > 0
    || Boolean(commitSha)
    || CHECKABLE_VERIFICATION_RE.test(verification || "");
  return !evidenced && ANSWER_OPENER_RE.test(String(summary || "").trim());
}

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
  // Answer-prose demotion (value audit IV). The memory contract asks every session to close with
  // a "Verification:" line, so that label alone stopped separating a fix report from an ordinary
  // conversational answer: a session's answer *about* memory pollution was stored as a durable
  // fix and re-injected as project history in the very next session, where it competed for the
  // brief's five fix slots. Demote only when BOTH signals agree — the summary opens by answering
  // the reader, and nothing re-checkable is attached. Either signal alone is too weak: real fix
  // reports open conversationally ("Done. Added the CTA…") and real results verify in prose
  // ("3y backtest + live paper validation"). Demoted records still land as session events, which
  // get one line in the next brief and can graduate to a fix on confirmation.
  if (!isAnswerProse(fields) && (fields.verification || (hasFiles && fields.commitSha))) {
    return { type: "fix", fields };
  }

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

// Headline tokens keep digit runs of ANY length, unlike dedupTokens' 3-char floor. Recurring
// reports are distinguished only by short numbers — "Market pulse 2026-07-09" vs "…-07-10",
// "canary Day-7" vs "Day-8" — and dropping those makes every day's report look like the same
// question. Letters keep the 3-char floor so "in an app" noise still washes out.
// A dotted/dashed numeric run stays ONE token: split into parts, "2026-07-07" becomes
// {2026, 07} once the Set eats the repeat, which is a strict subset of {2026, 07, 09} — so
// every dated report collapsed into the first one that happened to repeat a component.
export function keyTokens(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z]{3,}|\d+(?:[-/.]\d+)*/g) || []);
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

// Containment (overlap coefficient) rather than jaccard: how much of the SHORTER side is
// present in the longer one. Re-asking the same question with drifting wording only ever adds
// words ("…in an app?" → "…in an App Store app?"), so containment pins at 1. Two questions off
// the same template but about different subjects do not: "Does gapfade_pre strategy pass vetting
// gates?" vs the same for `meanrev` contains at 0.83, because each holds a token the other lacks.
export function containment(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

// `key` is the record's headline — a research question. It is compared separately because the
// combined signature buries it: the live DB stored one question 4× in 25 minutes at a combined
// similarity of 0.20–0.39 (far under `threshold`) while the questions themselves matched at
// 0.78–0.88. A long, freshly-worded finding drowns an identical question 2–4×.
export function isNearDuplicate(candidate, recentRecords = [], { threshold = 0.82, keyThreshold = 0.95 } = {}) {
  const candidateTokens = dedupTokens(candidate.signature);
  const candidateKey = keyTokens(candidate.key);
  if (!candidateTokens.size) return null;
  let best = null;
  for (const record of recentRecords) {
    const similarity = jaccard(candidateTokens, dedupTokens(record.signature));
    const keyOverlap = candidateKey.size ? containment(candidateKey, keyTokens(record.key)) : 0;
    // Either signal alone is enough: a matching body, or a question that is the same question.
    const score = Math.max(similarity, keyOverlap >= keyThreshold ? keyOverlap : 0);
    if ((similarity >= threshold || keyOverlap >= keyThreshold) && (!best || score > best.similarity)) {
      best = {
        duplicate: true,
        existingId: record.id,
        similarity: score,
        matchedOn: similarity >= threshold ? "signature" : "key",
        existingVerified: Boolean(record.verification) || record.qualityStatus === "verified",
      };
    }
  }
  return best;
}
