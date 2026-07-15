// First-pass reviewer: a cheap headless model reads the run's diff before a human does.
// It looks for exactly the things a green test run can't prove — secrets, dependency
// changes, scope creep vs the task, injection-shaped code — and returns a one-line verdict
// that rides along in the review evidence. Best-effort by design: any failure returns null
// and the run proceeds to human review exactly as before.
import { spawn, execFileSync } from "node:child_process";
import { killChild } from "./procKill.js";

const DIFF_CHAR_LIMIT = Number(process.env.CORTEX_REVIEWER_DIFF_CHARS || 60_000);
const REVIEW_TIMEOUT_MS = Number(process.env.CORTEX_REVIEWER_TIMEOUT_MIN || 5) * 60_000;

export function buildReviewPrompt(task, diff) {
  return [
    `You are reviewing a diff produced by an autonomous agent for this task: "${task.title}".`,
    task.acceptanceCriteria ? `Acceptance criteria: ${task.acceptanceCriteria}` : null,
    "Check ONLY for: hardcoded secrets/tokens/keys, new or changed dependencies, files changed that are unrelated to the task (scope creep), obviously dangerous operations (network calls to unknown hosts, shell injection, deleted safety checks).",
    "Respond with at most 5 short lines of findings, then a final line exactly of the form:",
    "VERDICT: clean   (nothing found)   or   VERDICT: concerns",
    "",
    "DIFF:",
    diff,
  ].filter((line) => line !== null).join("\n");
}

export function parseReviewVerdict(text) {
  const match = /VERDICT:\s*(clean|concerns)/i.exec(String(text || ""));
  if (!match) return null;
  const body = String(text).slice(0, 400).replace(/\s+/g, " ").trim();
  return { verdict: match[1].toLowerCase(), notes: body };
}

// Review the committed work in a run's worktree against its fork point. Returns
// { verdict: "clean"|"concerns", notes } or null (reviewer unavailable / unparseable).
export async function reviewRun({ worktreePath, baseRef, task, model = "haiku", spawnImpl = spawn, git = execFileSync, timeoutMs = REVIEW_TIMEOUT_MS }) {
  let diff;
  try {
    diff = String(git("git", ["-C", worktreePath, "diff", `${baseRef}...HEAD`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }) || "");
  } catch {
    return null;
  }
  if (!diff.trim()) return { verdict: "clean", notes: "empty diff" };
  if (diff.length > DIFF_CHAR_LIMIT) diff = `${diff.slice(0, DIFF_CHAR_LIMIT)}\n[diff truncated]`;

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
    child.once("close", (code) => finish(code === 0 ? parseReviewVerdict(out) : null));
    child.stdin.end(buildReviewPrompt(task, diff));
  });
}
