#!/usr/bin/env node
/**
 * PreToolUse hook (Edit|Write|MultiEdit): just-in-time, file-triggered recall.
 * The session-start brief arrives before the agent knows what it will touch; this fires at
 * the exact moment a session first edits a file the hub has history on — a 2-3 line note
 * with the fix count, the latest fix's citable id, and any lesson. Once per file per session.
 * Registered in ~/.claude/settings.json; must ALWAYS exit 0 fast — it runs on every edit.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCortex } from "./index.js";

const MIN_FIXES = Number(process.env.CORTEX_JIT_MIN_FIXES || 2);
// Above this many matches the bucket is ambient project history, not file-specific signal.
// Oversized buckets used to be suppressed outright — which silenced JIT on exactly the
// fragile files with the most history (30% of live first-touch checks). The near-random
// "Latest:" pick that motivated the cap is fixed by ranking instead: verified-first, then
// recency. The dir/base suffix matcher below already removed the basename-collision noise.
const MAX_FIXES = Number(process.env.CORTEX_JIT_MAX_FIXES || 8);

const segments = (f) => String(f || "").toLowerCase().replaceAll("\\", "/").split("/").filter(Boolean);
const fileBase = (f) => segments(f).pop();

// Does a stored fix path point at the edited file? dir/base suffix when the stored path has a
// directory (hot basenames like styles.css collide across projects and folders — 10 of 24 live
// JIT events matched ≥15 unrelated fixes on basename alone); bare stored basenames keep the
// old basename match, since they carry no directory to disambiguate with.
function matchesEditedFile(storedPath, editedSuffix, editedBase) {
  const parts = segments(storedPath);
  if (!parts.length) return false;
  if (parts.length === 1) return parts[0] === editedBase;
  return parts.slice(-2).join("/") === editedSuffix;
}

// Pure decision + rendering, injectable storage for tests. Returns the note string or null.
// Emits the jit_recall metric only when a note fires, so a file that gains history later in
// the session can still trigger on its next first-touch check.
export function buildJitNote(storage, { projectPath, filePath, sessionId }) {
  if (!filePath || !sessionId) return null;
  if (!storage.getProjectProfile(projectPath)) return null;
  const parts = segments(filePath);
  const base = parts.pop();
  if (!base) return null;
  const editedSuffix = parts.length ? `${parts[parts.length - 1]}/${base}` : base;
  // session-scoped query (not a shared 200-row window): concurrent sessions pushed this
  // session's rows out of the window, re-noting the same file
  const alreadyNoted = storage.listMetrics(projectPath, { kind: "jit_recall", sessionId, limit: 200 })
    .some((m) => m.payload?.file === base);
  if (alreadyNoted) return null;

  const fixes = storage.listFixes(projectPath, { limit: 100 })
    .filter((fix) => fix.qualityStatus !== "quarantined"
      && (fix.filesChanged || []).some((f) => matchesEditedFile(f, editedSuffix, base)));
  const lessons = storage.listLessons(projectPath, { limit: 20 })
    .filter((l) => String(l.statement || "").toLowerCase().includes(base));
  // one prior fix is weak signal; this fires machine-wide on every first-touch, so demand
  // either a repeat-offender file or an explicit lesson before spending the agent's attention
  if (fixes.length < MIN_FIXES && !lessons.length) return null;
  // Oversized bucket: rank instead of suppressing — prefer the newest VERIFIED fix, which is
  // exactly the pick that was near-random when this branch returned null.
  const oversized = fixes.length > MAX_FIXES;
  const latest = oversized
    ? fixes.find((f) => f.verification || f.qualityStatus === "verified") || fixes[0]
    : fixes[0];
  const noteParts = [`Cortex — you are editing ${base}: ${fixes.length} prior fix(es) recorded here.`];
  if (latest) noteParts.push(`Latest: [m:${String(latest.id).replace(/-/g, "").slice(0, 6)}] ${String(latest.summary || "").slice(0, 140)}`);
  if (lessons.length) noteParts.push(`Lesson: ${String(lessons[0].statement).slice(0, 120)}`);
  noteParts.push("(cite the id if it helps; mark Stale: [m:id] if it's wrong)");
  const note = noteParts.join(" ");
  // servedFixIds lets the mid-Aug audit join citations back to JIT-served records;
  // noteTokens makes the JIT rail's cost separable from the brief's in the audit metric
  try { storage.recordMetric("jit_recall", projectPath, { sessionId, file: base, fixCount: fixes.length, oversized, servedFixIds: latest ? [latest.id] : [], noteTokens: Math.ceil(note.length / 3.5) }); } catch { /* telemetry only */ }
  return note;
}

function main() {
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = readFileSync(0, "utf8").trim();
      payload = raw ? JSON.parse(raw) : {};
    }
  } catch { /* malformed payload -> no note */ }
  // relative_path is Serena's field (replace_symbol_body, insert_*_symbol, replace_content) —
  // the symbol-level edit path the global CLAUDE.md steers sessions toward never fired JIT
  const filePath = payload?.tool_input?.file_path || payload?.tool_input?.TargetFile
    || payload?.tool_input?.AbsolutePath || payload?.tool_input?.relative_path
    || payload?.tool_input?.notebook_path;
  const sessionId = payload?.session_id || payload?.conversation_id || process.env.ANTIGRAVITY_TRAJECTORY_ID;
  if (!filePath || !sessionId) return;
  let hub;
  try {
    hub = createCortex({
      dbPath: process.env.CORTEX_DB || join(homedir(), ".cortex", "cortex.sqlite"),
    });
    const note = buildJitNote(hub.storage, {
      projectPath: payload.cwd || process.cwd(),
      filePath,
      sessionId,
    });
    if (note) {
      console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note },
      }));
    }
  } catch { /* never block an edit */ }
  finally { try { hub?.close(); } catch { /* already closed */ } }
}

// Run only as the hook entry point: importing buildJitNote (tests) must not touch stdin —
// readFileSync(0) blocks forever on a non-TTY stdin that never closes, wedging the importer.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
