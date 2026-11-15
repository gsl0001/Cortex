import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCortex } from "../src/index.js";
import { consolidate, mineCandidates, parseDraft } from "../src/consolidate.js";

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-consolidate-"));
  const project = join(dir, "repo");
  const skillsDir = join(dir, "skills");
  await mkdir(project);
  await mkdir(join(skillsDir, "weekly-report"), { recursive: true });
  await writeFile(join(skillsDir, "weekly-report", "SKILL.md"), "# weekly-report\n\nRender the report from the template.\n");
  const hub = createCortex({ dbPath: join(dir, "hub.sqlite") });
  try {
    await fn({ hub, dir, project, skillsDir, out: join(dir, "proposals") });
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function decision(hub, project, text, at, supersedesId = null) {
  const id = randomUUID();
  hub.storage.insertDecision({ id, projectPath: project, agent: "claude-code", decision: text, rationale: "", supersedesId });
  hub.storage.db.prepare("UPDATE decision_entries SET created_at = ? WHERE id = ?").run(at, id);
  return id;
}

function fix(hub, project, summary, at) {
  const id = randomUUID();
  hub.storage.insertFix({ id, projectPath: project, agent: "claude-code", summary, filesChanged: [], verification: "npm test passed" });
  hub.storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id = ?").run(at, id);
  return id;
}

function metric(hub, project, kind, payload, at) {
  hub.storage.recordMetric(kind, project, payload);
  hub.storage.db.prepare("UPDATE metrics_events SET created_at = ? WHERE rowid = (SELECT max(rowid) FROM metrics_events)").run(at);
}

const RULE = "Check the nightly-upload queue for unpublished planned jobs before queuing a new video";

test("a rule restated on three days becomes a candidate; a one-off fix does not", async () => {
  await withHub(async ({ hub, project, skillsDir }) => {
    const first = decision(hub, project, RULE, daysAgo(6));
    const second = decision(hub, project, `${RULE} again`, daysAgo(4), first);
    decision(hub, project, `${RULE} (restated)`, daysAgo(2), second);
    fix(hub, project, "Fixed a typo in the onboarding screen copy", daysAgo(3));

    const mined = mineCandidates(hub.storage, { since: "7d", skillsDir });
    assert.equal(mined.targets.length, 1);
    const [entry] = mined.targets;
    assert.equal(entry.target.kind, "repo");
    assert.match(entry.target.path, /CLAUDE\.md$/);
    assert.equal(entry.exists, false);
    assert.equal(entry.candidates.length, 1, "the chain collapses to its newest record");
    assert.equal(entry.candidates[0].days, 3);
    assert.deepEqual(entry.candidates[0].signals, { captured: 1, restated: 2 });
  });
});

test("one rule worded in two separate chains merges; a session's status report never qualifies", async () => {
  await withHub(async ({ hub, project, skillsDir }) => {
    const older = decision(hub, project, "Swift AppKit with Developer ID distribution for Acme on macOS, not the App Store", daysAgo(5));
    const newer = decision(hub, project, "Acme on macOS ships as Swift AppKit with Developer ID distribution instead of the App Store", daysAgo(2));
    const report = decision(hub, project, "I rendered the video and marked build-tiktok-001 as rendered for approval", daysAgo(6));
    decision(hub, project, "I rendered the video and marked build-tiktok-002 as rendered for approval", daysAgo(3), report);

    const [entry] = mineCandidates(hub.storage, { since: "7d", skillsDir }).targets;
    assert.equal(entry.candidates.length, 1);
    assert.equal(entry.candidates[0].id, newer, "the newest wording speaks for the cluster");
    assert.deepEqual(entry.candidates[0].also, [older.replace(/-/g, "").slice(0, 6)]);
    assert.equal(entry.candidates[0].days, 2);
  });
});

test("duplicate captures and citations on other days count as recurrence", async () => {
  await withHub(async ({ hub, project, skillsDir }) => {
    const id = fix(hub, project, "Retry the S3 upload when the object reports not uploaded for a few seconds after upload", daysAgo(5));
    metric(hub, project, "capture_outcome", { reason: "discarded_near_duplicate", recordId: id }, daysAgo(3));
    metric(hub, project, "recall_cited", { idPrefix: id.replace(/-/g, "").slice(0, 6), sessionId: "s-9" }, daysAgo(1));
    const [entry] = mineCandidates(hub.storage, { since: "7d", skillsDir }).targets;
    assert.deepEqual(entry.candidates[0].signals, { captured: 1, recaptured: 1, cited: 1 });
    assert.equal(entry.candidates[0].days, 3);
    assert.equal(mineCandidates(hub.storage, { since: "2d", skillsDir }).targets.length, 0, "the window bounds the evidence");
  });
});

test("a record naming a skill targets that skill's SKILL.md", async () => {
  await withHub(async ({ hub, project, skillsDir }) => {
    const first = decision(hub, project, "In the weekly-report template edit both the SECTIONS array and the REPORT object", daysAgo(5));
    decision(hub, project, "In the weekly-report template always edit both the SECTIONS array and the REPORT object", daysAgo(1), first);
    const [entry] = mineCandidates(hub.storage, { since: "7d", skillsDir }).targets;
    assert.equal(entry.target.kind, "skill");
    assert.equal(entry.target.path, join(skillsDir, "weekly-report", "SKILL.md"));
    assert.equal(entry.exists, true);
  });
});

test("a rule the target file already states is skipped; a contradicted line is flagged", async () => {
  await withHub(async ({ hub, project, skillsDir }) => {
    await writeFile(join(project, "CLAUDE.md"), [
      "# Repo", "",
      `- ${RULE}.`,
      "- Builds for iOS always run in the cloud with eas build and never on the local MacBook runner.", "",
    ].join("\n"));
    const first = decision(hub, project, RULE, daysAgo(6));
    decision(hub, project, `${RULE} again`, daysAgo(2), first);
    const stale = decision(hub, project, "Builds for iOS always run in the cloud with eas build, never on the local MacBook", daysAgo(20));
    metric(hub, project, "recall_contradicted", { idPrefix: stale.replace(/-/g, "").slice(0, 6), reason: "builds moved to the local Mac" }, daysAgo(1));

    const [entry] = mineCandidates(hub.storage, { since: "7d", skillsDir }).targets;
    assert.equal(entry.candidates.length, 0);
    assert.equal(entry.alreadyDocumented, 1);
    assert.equal(entry.outdated.length, 1);
    assert.match(entry.outdated[0].line, /eas build/);
  });
});

test("consolidate writes proposal files and never touches the target file", async () => {
  await withHub(async ({ hub, project, skillsDir, out }) => {
    await writeFile(join(project, "CLAUDE.md"), "# Repo\n");
    const first = decision(hub, project, RULE, daysAgo(6));
    decision(hub, project, `${RULE} again`, daysAgo(2), first);

    const result = await consolidate(hub, { since: "7d", skillsDir, outDir: out });
    assert.equal(result.targets.length, 1);
    const files = await readdir(result.outDir);
    assert.deepEqual(files.sort(), ["README.md", "repo.md"]);
    const proposal = await readFile(join(result.outDir, "repo.md"), "utf8");
    assert.match(proposal, /## Recurring records/);
    assert.match(proposal, /nightly-upload queue/);
    assert.doesNotMatch(proposal, /model draft/, "no draft section without --draft");
    assert.equal(await readFile(join(project, "CLAUDE.md"), "utf8"), "# Repo\n");
  });
});

test("two repos with the same basename get separate proposal files", async () => {
  await withHub(async ({ hub, dir, skillsDir, out }) => {
    const a = join(dir, "client-a", "repo");
    const b = join(dir, "client-b", "repo");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    for (const project of [a, b]) {
      const first = decision(hub, project, RULE, daysAgo(6));
      decision(hub, project, `${RULE} again`, daysAgo(2), first);
    }
    const result = await consolidate(hub, { since: "7d", skillsDir, outDir: out });
    assert.equal(result.targets.length, 2);
    assert.equal(new Set(result.targets.map((t) => t.file)).size, 2);
    const files = (await readdir(result.outDir)).filter((name) => name !== "README.md");
    assert.equal(files.length, 2);
    assert.ok(files.includes("repo.md"));
    assert.ok(files.some((name) => /^repo-[0-9a-f]{6}\.md$/.test(name)));
  });
});

function fakeModel(output, code = 0) {
  const prompts = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (chunk) => prompts.push(String(chunk)));
    child.kill = () => child.emit("close", 143);
    setImmediate(() => { child.stdout.end(output); child.emit("close", code); });
    return child;
  };
  return { spawnImpl, prompts };
}

test("--draft adds the model's lines; a failed model call still writes the evidence", async () => {
  await withHub(async ({ hub, project, skillsDir, out }) => {
    const first = decision(hub, project, RULE, daysAgo(6));
    decision(hub, project, `${RULE} again`, daysAgo(2), first);

    const model = fakeModel("ADD\n- Check the nightly-upload queue before queuing a video. [m:abc123]\nREMOVE\n");
    const ok = await consolidate(hub, { since: "7d", skillsDir, outDir: out, draft: true, spawnImpl: model.spawnImpl });
    assert.equal(ok.targets[0].drafted, 1);
    assert.match(model.prompts.join(""), /Current file:[\s\S]*does not exist yet/);
    assert.match(await readFile(join(ok.outDir, "repo.md"), "utf8"), /## Suggested lines \(model draft\)\n\n- Check the nightly-upload queue/);

    const down = fakeModel("", 1);
    const failed = await consolidate(hub, { since: "7d", skillsDir, outDir: join(out, "second"), draft: true, spawnImpl: down.spawnImpl });
    assert.equal(failed.targets[0].drafted, "failed");
    const text = await readFile(join(failed.outDir, "repo.md"), "utf8");
    assert.match(text, /Draft unavailable/);
    assert.match(text, /## Recurring records/);
  });
});

test("parseDraft reads ADD/REMOVE sections and NOTHING", () => {
  assert.deepEqual(parseDraft("NOTHING"), { add: [], remove: [] });
  assert.deepEqual(parseDraft("ADD\n- one [m:aaaaaa]\n* two\nREMOVE\n- old line\nstray text"), {
    add: ["one [m:aaaaaa]", "two"], remove: ["old line"],
  });
});
