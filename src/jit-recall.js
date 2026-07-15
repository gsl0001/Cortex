#!/usr/bin/env node
/**
 * PreToolUse hook (Edit|Write|MultiEdit): just-in-time, file-triggered recall.
 * The session-start brief arrives before the agent knows what it will touch; this fires at
 * the exact moment a session first edits a file the hub has history on — a 2-3 line note
 * with the fix count, the latest fix's citable id, and any lesson. Once per file per session.
 * Registered in ~/.claude/settings.json; must ALWAYS exit 0 fast — it runs on every edit.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCortex } from "./index.js";

const MIN_FIXES = Number(process.env.CORTEX_JIT_MIN_FIXES || 2);

const fileBase = (f) => String(f || "").toLowerCase().replaceAll("\\", "/").split("/").pop();

// Pure decision + rendering, injectable storage for tests. Returns the note string or null.
// Emits the jit_recall metric only when a note fires, so a file that gains history later
// in the session can still trigger on its next first-touch check.
export function buildJitNote(storage, { projectPath, filePath, sessionId }) {
  if (!filePath || !sessionId) return null;
  if (!storage.getProjectProfile(projectPath)) return null;
  const base = fileBase(filePath);
  if (!base) return null;
  const alreadyNoted = storage.listMetrics(projectPath, { kind: "jit_recall", limit: 200 })
    .some((m) => m.payload?.sessionId === sessionId && m.payload?.file === base);
  if (alreadyNoted) return null;

  const fixes = storage.listFixes(projectPath, { limit: 100 })
    .filter((fix) => fix.qualityStatus !== "quarantined"
      && (fix.filesChanged || []).some((f) => fileBase(f) === base));
  const lessons = storage.listLessons(projectPath, { limit: 20 })
    .filter((l) => String(l.statement || "").toLowerCase().includes(base));
  // one prior fix is weak signal; this fires machine-wide on every first-touch, so demand
  // either a repeat-offender file or an explicit lesson before spending the agent's attention
  if (fixes.length < MIN_FIXES && !lessons.length) return null;

  const latest = fixes[0];
  const parts = [`Cortex — you are editing ${base}: ${fixes.length} prior fix(es) recorded here.`];
  if (latest) parts.push(`Latest: [m:${String(latest.id).replace(/-/g, "").slice(0, 6)}] ${String(latest.summary || "").slice(0, 140)}`);
  if (lessons.length) parts.push(`Lesson: ${String(lessons[0].statement).slice(0, 120)}`);
  parts.push("(cite the id if it helps; mark Stale: [m:id] if it's wrong)");
  const note = parts.join(" ");
  try { storage.recordMetric("jit_recall", projectPath, { sessionId, file: base, fixCount: fixes.length }); } catch { /* telemetry only */ }
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
  const filePath = payload?.tool_input?.file_path;
  const sessionId = payload?.session_id;
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
