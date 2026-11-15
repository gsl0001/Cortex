// Transcript distillation: the Stop hook captures only a session's FINAL message, so a
// three-hour session yields one candidate — usually a wrap-up summary, while the root causes
// and dead ends discovered mid-session evaporate. The hook (10s budget) enqueues a distill
// job; the server drains the queue asynchronously, running a cheap model over the transcript
// to extract up to three structured records, each fed through the normal capture gate.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { killChild } from "./procKill.js";

const MIN_ASSISTANT_TURNS = Number(process.env.CORTEX_DISTILL_MIN_TURNS || 8);
const TRANSCRIPT_CHAR_BUDGET = Number(process.env.CORTEX_DISTILL_CHARS || 24_000);
const DISTILL_TIMEOUT_MS = Number(process.env.CORTEX_DISTILL_TIMEOUT_MIN || 5) * 60_000;

// Every assistant text turn from a Claude Code transcript JSONL, oldest first.
export function transcriptAssistantTexts(transcriptPath) {
  let lines;
  try { lines = readFileSync(transcriptPath, "utf8").trim().split("\n"); } catch { return []; }
  const texts = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    const text = typeof content === "string"
      ? content
      : (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text.trim()) texts.push(text.trim());
  }
  return texts;
}

// Last-heavy sampling: the end of a session (conclusions) matters more than the start,
// but keep the opening turns so the model sees what the session set out to do.
export function sampleTranscript(texts, budget = TRANSCRIPT_CHAR_BUDGET) {
  const joined = texts.join("\n\n---turn---\n\n");
  if (joined.length <= budget) return joined;
  const head = joined.slice(0, Math.floor(budget * 0.2));
  const tail = joined.slice(-Math.floor(budget * 0.8));
  return `${head}\n\n[...transcript trimmed...]\n\n${tail}`;
}

export function buildDistillPrompt(transcriptSample) {
  return [
    "You are distilling a coding-agent session transcript into durable memory records.",
    "Extract AT MOST 3 records worth remembering across future sessions: root causes found,",
    "approaches that failed and why (dead ends), and significant decisions. Skip routine progress.",
    "Each record must be 1-3 sentences and MUST use this label grammar on one line each:",
    '- a fix/root-cause: "<what was wrong and the insight>. Files changed: <paths>. Verification: <how it was proven>."',
    '- a decision: "Decision: <what was chosen>. Rationale: <why>. Alternatives: <what was rejected>."',
    '- a finding: "Question: <what was investigated>? Finding: <the answer>."',
    "Only include records the transcript actually supports — no invention. If nothing is worth",
    "remembering, output exactly: NOTHING",
    "Output ONLY the records — no preamble, no commentary before or after.",
    "Separate records with a line containing only: ===",
    "",
    "TRANSCRIPT:",
    transcriptSample,
  ].join("\n");
}

// Split the model's output into candidate record messages (the capture gate does the rest).
// Live output showed the model separating with "---" despite the "===" instruction, fusing
// its preamble into the first record's summary — accept both separators so a preamble splits
// into its own block (which the low-signal gate then discards) instead of polluting a fix.
export function parseDistilledRecords(output) {
  const text = String(output || "").trim();
  if (!text || /^NOTHING\b/i.test(text)) return [];
  return text.split(/^\s*(?:===+|---+)\s*$/m)
    .map((block) => block.trim())
    .filter((block) => block.length >= 40)
    .slice(0, 3);
}

// Shared with the consolidation run (consolidate.js).
export function runModel(prompt, { model, spawnImpl = spawn, timeoutMs = DISTILL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        process.platform === "win32" ? "claude.cmd" : "claude",
        ["-p", "--model", model],
        { shell: process.platform === "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      return resolve(null);
    }
    let out = "";
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { killChild(child); finish(null); }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? out : null));
    child.stdin.end(prompt);
  });
}

// Drain one queued job. Returns a status string for telemetry/tests. Best-effort by design:
// any failure marks the job and moves on — distillation must never wedge the server.
export async function runNextDistillJob(hub, { spawnImpl = spawn, minTurns = MIN_ASSISTANT_TURNS } = {}) {
  const job = hub.storage.nextDistillJob();
  if (!job) return "idle";
  try {
    const texts = transcriptAssistantTexts(job.transcriptPath);
    if (texts.length < minTurns) {
      hub.storage.finishDistillJob(job.id, { status: "skipped_short" });
      return "skipped_short";
    }
    const model = hub.storage.getSetting("distill.model", "haiku");
    const output = await runModel(buildDistillPrompt(sampleTranscript(texts)), { model, spawnImpl });
    if (output === null) {
      hub.storage.finishDistillJob(job.id, { status: "error", error: "model unavailable or timed out" });
      return "error";
    }
    const records = parseDistilledRecords(output);
    for (const message of records) {
      // source "distill" and no transcriptPath: distilled captures must never re-enqueue
      hub.captureCandidate({
        projectPath: job.projectPath,
        agent: job.agent || "distill",
        source: "distill",
        message,
      });
    }
    hub.storage.finishDistillJob(job.id, { status: "done" });
    return `done:${records.length}`;
  } catch (error) {
    try { hub.storage.finishDistillJob(job.id, { status: "error", error: String(error.message).slice(0, 200) }); } catch { /* queue row stays pending */ }
    return "error";
  }
}
