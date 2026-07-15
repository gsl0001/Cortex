#!/usr/bin/env node
/**
 * task-update.js — title-based task status updater for Cortex
 *
 * Usage:
 *   node task-update.js --db <path> --project <path> --title <substring> --status <status> [--evidence <text>] [--commit <sha>]
 *
 * Statuses: backlog | ready | in_progress | blocked | review | done
 */

import { createCortex, updateTaskByReference } from "./index.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

if (!flags.db || (!flags.id && !flags.title) || !flags.status) {
  console.error("Usage: node task-update.js --db <path> --project <path> (--id <id> | --title <substring>) --status <status> [--evidence <text>] [--commit <sha>]");
  process.exit(1);
}

const hub = createCortex({ dbPath: flags.db });
try {
  const result = updateTaskByReference(hub, {
    projectPath: flags.project || process.cwd(),
    id: flags.id,
    title: flags.title,
    status: flags.status,
    agent: flags.agent,
    branch: flags.branch,
    evidence: flags.evidence,
    reason: flags.reason,
    commitSha: flags.commit,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`cortex task update: ${error.message}`);
  process.exitCode = 1;
} finally {
  hub.close();
}
