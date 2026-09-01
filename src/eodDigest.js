// Optional agent layer for the evening brief: one batched headless-claude call
// rewrites each raw DB item (fix/research/decision/task) into a plain-English
// one-liner and writes a short "story of the day". Strictly additive — any
// failure (CLI missing, OAuth expired, bad JSON, timeout) leaves the report
// exactly as the SQL layer built it, with digestError set for the footer.

import { spawnSync } from "node:child_process";

// Stable keys so the model's JSON maps back to rows without echoing full text.
const ITEM_SOURCES = [
  ["t", (r) => r.done.tasks, (x) => `task done: ${x.title} (evidence: ${x.evidence || "none"})`],
  ["f", (r) => r.done.fixes, (x) => `fix: ${x.summary}`],
  ["d", (r) => r.done.decisions, (x) => `decision: ${x.decision} — rationale: ${x.rationale}`],
  ["r", (r) => r.done.research, (x) => `research: ${x.question} — finding: ${x.finding}`],
  ["e", (r) => r.needsEyes.blocked, (x) => `blocked task: ${x.title} — reason: ${x.block_reason}`],
  ["v", (r) => r.verifyQueue.tasks, (x) => `needs verification: ${x.title} (run: ${x.verification_command})`],
  ["o", (r) => r.tonight.open, (x) => `open task: ${x.title}`],
];
const MAX_DIGEST_ITEMS = 150; // one batched call — bound the prompt on pathological days

function digestItems(report) {
  const items = [];
  for (const [prefix, pick, describe] of ITEM_SOURCES) {
    const rows = pick(report);
    if (!Array.isArray(rows)) continue; // section errored — nothing to summarize
    rows.forEach((row, i) => items.push({ key: `${prefix}${i}`, row, text: describe(row) }));
  }
  return items.slice(0, MAX_DIGEST_ITEMS);
}

export function buildDigestPrompt(report) {
  const items = digestItems(report);
  return {
    items,
    prompt: [
      "You summarize a developer's daily activity report for a non-technical evening read on a phone.",
      "For each item below, write ONE plain-English sentence (max 110 chars): what happened and why it matters.",
      "No jargon, no file paths, no commit hashes. Keep project-specific nouns.",
      "Also write `story`: 2-3 sentences summarizing the day overall — what moved, what's stuck, what deserves attention tonight.",
      'Reply with ONLY a JSON object, no markdown fences: {"story": "...", "items": {"<key>": "<sentence>", ...}}',
      "",
      ...items.map(({ key, text }) => `${key}: ${text}`),
    ].join("\n"),
  };
}

// Merge model output back onto the report rows as `.summary_plain` (renderers
// prefer it when present). Unknown keys are ignored; missing keys keep raw text.
export function applyDigest(report, items, parsed) {
  if (!parsed || typeof parsed !== "object") return report;
  const byKey = new Map(items.map(({ key, row }) => [key, row]));
  for (const [key, sentence] of Object.entries(parsed.items || {})) {
    const row = byKey.get(key);
    if (row && typeof sentence === "string" && sentence.trim()) row.summary_plain = sentence.trim();
  }
  if (typeof parsed.story === "string" && parsed.story.trim()) report.story = parsed.story.trim();
  return report;
}

export function defaultRunAgent(prompt, { timeoutMs = 180_000 } = {}) {
  // One literal command string under shell:true — Node >= 20.12 refuses to spawn
  // .cmd files directly (EINVAL), and string form avoids DEP0190. The prompt goes
  // via stdin, so nothing user-controlled touches the command line.
  const cmd = `${process.platform === "win32" ? "claude.cmd" : "claude"} -p --model haiku --output-format text`;
  const res = spawnSync(cmd, {
    input: prompt, encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr || "").slice(0, 200)}`);
  return res.stdout;
}

export function runDigest(report, { runAgent = defaultRunAgent } = {}) {
  try {
    const { items, prompt } = buildDigestPrompt(report);
    if (!items.length) return report;
    const raw = runAgent(prompt);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in agent output");
    return applyDigest(report, items, JSON.parse(raw.slice(start, end + 1)));
  } catch (error) {
    report.digestError = String(error.message || error);
    return report;
  }
}
