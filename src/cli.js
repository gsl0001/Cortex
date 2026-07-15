#!/usr/bin/env node
// Node version guard MUST run before anything imports node:sqlite (storage.js), or the
// import chain throws ERR_UNKNOWN_BUILTIN_MODULE first and buries this clear message.
// Static imports hoist above top-level code, so ./index.js is loaded dynamically in runCli.
if (Number(process.versions.node.split(".")[0]) < 25) {
  console.error(`Cortex needs Node >= 25 (node:sqlite); found ${process.version}`);
  process.exit(1);
}
import { readFileSync } from "node:fs";


function printVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`cortex ${pkg.version || "0.0.0"}`);
  } catch {
    console.log("cortex 0.0.0");
  }
}

function readStdinJson() {
  try {
    const input = readFileSync(0, "utf8").trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      // --flag=value is unambiguous even when value is empty or itself looks like a flag
      // (e.g. --title="--priority" or --files=) — use it for anything the space-separated
      // form's "does the next token look like a flag" heuristic can't represent safely.
      const eq = value.indexOf("=");
      if (eq !== -1) {
        flags[value.slice(2, eq)] = value.slice(eq + 1);
        continue;
      }
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positionals.push(value);
    }
  }

  return { positionals, flags };
}

function listFlag(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function print(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result?.text) {
    console.log(result.text);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function usage() {
  return `Usage:
  cortex profile upsert --project . --name "Project" --mode "mode" --summary "summary"
  cortex task add --project . --title "Fix thing" --type bug --priority high
    (--type one of: feature|bug|chore|docs|test|research|infra — required)
  cortex task claim --id <id> --agent claude-code
  cortex task block --id <id> --reason "missing adb"
  cortex task done --id <id> --evidence "npm test passed"
  cortex next-task --project . [--claim --agent claude-code]
  cortex research add --project . --agent codex --question "What failed?" --finding "Root cause"
  cortex fix add --project . --agent codex --summary "Fixed issue" --verification "npm test passed"
  cortex session start --project . --agent claude-code --source remote-control --goal "Release work"
  cortex session finish --id <id>
  cortex claude install --project .
  cortex claude recall
  cortex claude flush
  cortex audit --all --json [--fix] [--apply]
  cortex search --project . --query "close fill" --max-tokens 1500
  cortex index rebuild
  cortex brief --project .
  cortex stats --project . --json
  cortex maintenance sweep
  cortex inbox add --project . --author human --message "Prioritize the auth bug"
  cortex inbox list --project .
  cortex inbox resolve --project . --id <id>
  cortex roadmap proposal-add --project . --agent codex --file roadmap.json
  cortex roadmap proposal-approve --id <id> --agent human
  cortex roadmap show --project . --json
  cortex goals --today 2026-06-29 --json
  cortex week show --start 2026-06-29 --capacity 10 --json
  cortex week auto-plan --start 2026-06-29 --capacity 10 --agent human --json

List flags use comma-separated values: --files a.js,b.js --tags release,expo`;
}

export async function runCli(argv = process.argv.slice(2)) {
  const {
    createClaudeHookContext, createCortex, flushClaudeStop, flushCodexStop, installClaudeAdapter,
  } = await import("./index.js");
  const { positionals, flags } = parseArgs(argv);
  const [resource, action] = positionals;
  const hub = createCortex({ dbPath: flags.db || process.env.CORTEX_DB });

  try {
    let result;
    if (resource === "profile" && action === "upsert") {
      result = hub.upsertProjectProfile({
        projectPath: flags.project || process.cwd(),
        name: flags.name,
        mode: flags.mode,
        summary: flags.summary,
        standardCommands: listFlag(flags.commands),
        risks: listFlag(flags.risks),
        externalMemoryDirs: listFlag(flags["memory-dirs"]),
      });
    } else if (resource === "task" && action === "add") {
      result = hub.addTask({
        projectPath: flags.project || process.cwd(),
        title: flags.title,
        type: flags.type,
        status: flags.status,
        priority: flags.priority,
        relatedFiles: listFlag(flags.files),
        acceptanceCriteria: flags.acceptance,
        verificationCommand: flags.verify,
      });
    } else if (resource === "task" && action === "claim") {
      result = hub.claimTask({ id: flags.id, agent: flags.agent, branch: flags.branch });
    } else if (resource === "task" && action === "block") {
      result = hub.blockTask({ id: flags.id, reason: flags.reason });
    } else if (resource === "task" && action === "review") {
      result = hub.reviewTask({ id: flags.id, evidence: flags.evidence, commitSha: flags.commit });
    } else if (resource === "task" && action === "done") {
      result = hub.completeTask({ id: flags.id, evidence: flags.evidence, commitSha: flags.commit });
    } else if (resource === "tasks") {
      result = hub.listTasks({ projectPath: flags.project || process.cwd() });
    } else if (resource === "next-task" || resource === "next") {
      result = hub.nextTask({
        projectPath: flags.project || process.cwd(),
        claim: Boolean(flags.claim),
        agent: flags.agent,
        branch: flags.branch,
      });
    } else if (resource === "research" && action === "add") {
      result = hub.addResearchEntry({
        projectPath: flags.project || process.cwd(),
        agent: flags.agent,
        question: flags.question,
        sources: listFlag(flags.sources),
        evidence: listFlag(flags.evidence),
        finding: flags.finding,
        fixMade: flags.fix,
        verification: flags.verification,
        residualRisk: flags.risk,
        reuseTags: listFlag(flags.tags),
      });
    } else if (resource === "fix" && action === "add") {
      result = hub.addFixEntry({
        projectPath: flags.project || process.cwd(),
        agent: flags.agent,
        summary: flags.summary,
        filesChanged: listFlag(flags.files),
        commitSha: flags.commit,
        verification: flags.verification,
        residualRisk: flags.risk,
      });
    } else if (resource === "session" && action === "start") {
      result = hub.startSession({
        projectPath: flags.project || process.cwd(),
        agent: flags.agent,
        source: flags.source,
        goal: flags.goal,
        branch: flags.branch,
        dirtyFiles: listFlag(flags.dirty),
      });
    } else if (resource === "session" && action === "finish") {
      result = hub.finishSession({ id: flags.id });
    } else if (resource === "claude" && action === "install") {
      result = { settingsPath: await installClaudeAdapter({
        projectPath: flags.project || process.cwd(),
        settingsPath: flags.settings,
        cortexBin: flags.bin,
        dbPath: flags.db,
      }) };
    } else if (resource === "claude" && action === "recall") {
      const hookInput = readStdinJson();
      result = createClaudeHookContext(hub, {
        ...hookInput,
        cwd: flags.project || hookInput.cwd || process.cwd(),
      });
    } else if (resource === "claude" && action === "flush") {
      const hookInput = readStdinJson();
      result = await flushClaudeStop(hub, {
        ...hookInput,
        cwd: flags.project || hookInput.cwd || process.cwd(),
      });
    } else if (resource === "codex" && (action === "recall" || action === "flush")) {
      const hookInput = readStdinJson();
      const merged = {
        ...hookInput,
        agent_type: "codex",
        session_id: hookInput.session_id || hookInput.id,
        cwd: flags.project || hookInput.cwd || process.cwd(),
      };
      // recall output is agent-neutral (same hookSpecificOutput); only capture differs by adapter
      result = action === "recall" ? createClaudeHookContext(hub, merged) : await flushCodexStop(hub, merged);
    } else if (resource === "brief") {
      result = hub.buildBrief({ projectPath: flags.project || process.cwd() });
    } else if (resource === "audit") {
      result = hub.audit({
        projectPath: flags.all ? undefined : flags.project || process.cwd(),
        fix: Boolean(flags.fix),
        apply: Boolean(flags.apply),
      });
    } else if (resource === "search") {
      result = hub.search({
        projectPath: flags.project || process.cwd(),
        query: flags.query,
        maxTokens: Number(flags["max-tokens"] || (flags.deep ? 4000 : 1500)),
        halfLifeDays: Number(flags["half-life-days"] || 30),
        includeSuperseded: Boolean(flags["include-superseded"]),
      });
    } else if (resource === "stats") {
      result = hub.stats({ projectPath: flags.project || process.cwd(), since: flags.since });
    } else if (resource === "maintenance" && action === "sweep") {
      result = hub.sweep();
    } else if (resource === "index" && action === "rebuild") {
      result = hub.rebuildIndex();
    } else if (resource === "index" && action === "drain") {
      result = hub.drainIndex();
    } else if (resource === "inbox" && action === "add") {
      result = hub.addInboxItem({
        projectPath: flags.project || process.cwd(),
        author: flags.author || flags.agent || "human",
        message: flags.message,
      });
    } else if (resource === "inbox" && (action === "list" || !action)) {
      result = hub.listInbox({
        projectPath: flags.project || process.cwd(),
        includeResolved: Boolean(flags["include-resolved"]),
      });
    } else if (resource === "inbox" && action === "resolve") {
      result = hub.resolveInbox({ projectPath: flags.project || process.cwd(), id: flags.id });
    } else if (resource === "run" && action === "start") {
      result = hub.startRun({ agent: flags.agent, taskId: flags.task, verificationCommand: flags.verify });
    } else if (resource === "run" && action === "finish") {
      result = hub.finishRun({
        id: flags.id, verificationExit: flags.exit != null ? Number(flags.exit) : null,
        tokens: flags.tokens != null ? Number(flags.tokens) : null,
        toolCalls: flags["tool-calls"] != null ? Number(flags["tool-calls"]) : null,
        outcome: flags.outcome, notes: flags.notes,
      });
    } else if (resource === "roadmap" && action === "proposal-add") {
      if (!flags.file) throw new Error("--file is required");
      result = hub.createRoadmapProposal({
        projectPath: flags.project || process.cwd(),
        agent: flags.agent,
        payload: JSON.parse(readFileSync(flags.file, "utf8")),
      });
    } else if (resource === "roadmap" && action === "proposal-approve") {
      result = hub.approveRoadmapProposal({ id: flags.id, agent: flags.agent });
    } else if (resource === "roadmap" && action === "proposal-reject") {
      result = hub.rejectRoadmapProposal({ id: flags.id, agent: flags.agent, reason: flags.reason });
    } else if (resource === "roadmap" && action === "proposal-list") {
      result = hub.listRoadmapProposals({ projectPath: flags.project || process.cwd(), status: flags.status });
    } else if (resource === "roadmap" && action === "show") {
      result = hub.getRoadmap({ projectPath: flags.project || process.cwd() });
    } else if (resource === "goals") {
      result = hub.getGoalsPortfolio({ today: flags.today || new Date().toISOString().slice(0, 10) });
    } else if (resource === "goal" && action === "update") {
      result = hub.updateGoal({
        id: flags.id,
        status: flags.status,
        activeRank: flags.rank != null ? Number(flags.rank) : undefined,
        targetDate: flags["target-date"],
        weeklyCapacity: flags.capacity != null ? Number(flags.capacity) : undefined,
      });
    } else if (resource === "goal" && action === "achieve") {
      result = hub.confirmGoalAchieved({ id: flags.id });
    } else if (resource === "milestone" && action === "update") {
      result = hub.updateMilestone({
        id: flags.id,
        title: flags.title,
        sortOrder: flags.order != null ? Number(flags.order) : undefined,
        dueDate: flags["due-date"],
      });
    } else if (resource === "task" && action === "schedule") {
      result = hub.scheduleTask({ id: flags.id, scheduledFor: flags.date });
    } else if (resource === "week" && action === "show") {
      result = hub.getWeeklyPlan({ weekStart: flags.start, totalCapacity: flags.capacity != null ? Number(flags.capacity) : undefined });
    } else if (resource === "week" && action === "auto-plan") {
      result = hub.autoPlanWeeklyTasks({ weekStart: flags.start, totalCapacity: flags.capacity != null ? Number(flags.capacity) : undefined, agent: flags.agent });
    } else {
      console.log(usage());
      return 1;
    }

    print(result, flags.json);
    return 0;
  } catch (error) {
    console.error(`cortex: ${error.message}`);
    return 1;
  } finally {
    hub.close();
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) {
  process.exitCode = await runCli();
}
