import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { classifyCandidate, normalizeCandidate } from "../src/capturePolicy.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-dec-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("decision classification wins over research/fix and survives low-signal", () => {
  const withFields = (message) => classifyCandidate(normalizeCandidate({ projectPath: ".", message }));
  // decision beats research when both label sets present
  assert.equal(withFields("Decision: Use SQLite. Rationale: simplest. Question: x? Finding: y").type, "decision");
  // decision beats the fix keyword when there's no fix evidence competing for it
  assert.equal(withFields("Fixed the bug. Decision: revert the cache. Rationale: it caused races.").type, "decision");
  // a question-ending rationale is not discarded as low-signal
  assert.equal(withFields("Decision: Ship it. Rationale: is this fine?").type, "decision");
});

test("a fix report wins over a Decision:/Rationale: substring nested in its own Verification text", () => {
  const withFields = (message) => classifyCandidate(normalizeCandidate({ projectPath: ".", message }));
  const classification = withFields(
    "Fixed the retry bug. Verification: Decision: skip retries. Rationale: not worth it. Files changed: src/retry.js.",
  );
  assert.equal(classification.type, "fix");
  assert.match(classification.fields.summary, /Fixed the retry bug/);
  // a real decision with no fix keyword and no evidence labels is unaffected
  const stillDecision = withFields("Decision: skip retries. Rationale: not worth it.");
  assert.equal(stillDecision.type, "decision");
});

test("a non-English fix report with Files changed + Verification labels classifies as fix", () => {
  const withFields = (message) => classifyCandidate(normalizeCandidate({ projectPath: ".", message }));
  const classification = withFields(
    "修复了重试逻辑中的竞态条件。 Files changed: src/retry.js. Verification: npm test passed.",
  );
  assert.equal(classification.type, "fix");
});

test("NUL bytes are stripped from captured messages before storage", () => {
  const candidate = normalizeCandidate({ projectPath: ".", message: "Fixed the b\0ug. Files changed: a.js." });
  assert.equal(candidate.message.includes("\0"), false);
  assert.match(candidate.message, /Fixed the bug/);
});

test("decision captured, exact-deduped, searchable, and in brief", async () => {
  await withHub(async (hub, dir) => {
    const msg = "Decision: Adopt WAL mode. Rationale: safe concurrent reads. Alternatives: rollback journal.";
    const r = hub.captureCandidate({ projectPath: dir, agent: "codex", message: msg });
    assert.equal(r.action, "accepted");
    assert.equal(r.recordType, "decision");
    assert.equal(hub.captureCandidate({ projectPath: dir, agent: "codex", message: msg }).action, "discarded");
    assert.equal(hub.search({ projectPath: dir, query: "WAL mode" }).results.length, 1);
    assert.match(hub.buildBrief({ projectPath: dir, context: { goalText: "adopt WAL mode for concurrent reads" } }).text, /Recent Decisions[\s\S]*Adopt WAL mode/);
  });
});

test("same decision with materially changed rationale is NOT a duplicate", async () => {
  await withHub(async (hub, dir) => {
    hub.captureCandidate({ projectPath: dir, agent: "a", message: "Decision: Use bearer tokens. Rationale: simple stateless guard for loopback dev." });
    const second = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Decision: Use bearer tokens. Rationale: mandatory once the server is exposed off loopback to remote agents." });
    assert.equal(second.action, "accepted");
  });
});

test("inbox: requires fields, stays out of the brief, resolves only within its project", async () => {
  await withHub(async (hub, dir) => {
    assert.throws(() => hub.addInboxItem({ projectPath: dir, author: "human" }), /message is required/);
    assert.throws(() => hub.addInboxItem({ projectPath: dir, message: "x" }), /author is required/);
    const item = hub.addInboxItem({ projectPath: dir, author: "human", message: "Prioritize the auth bug" });
    // Inbox dropped from the brief (value audit V): 0 rows were ever written in production.
    // The API and store still work; the brief just no longer carries the section.
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir, context: { goalText: "prioritize the auth bug" } }).text, /Inbox \(from human\)/);
    assert.throws(() => hub.resolveInbox({ projectPath: join(dir, "other"), id: item.id }), /not found/); // cross-project leak guarded
    hub.resolveInbox({ projectPath: dir, id: item.id });
    assert.equal(hub.listInbox({ projectPath: dir }).length, 0);
  });
});

test("listInboxItems filters expired items without relying on the sweep", async () => {
  await withHub(async (hub, dir) => {
    const item = hub.addInboxItem({ projectPath: dir, author: "human", message: "stale note" });
    hub.storage.db.prepare("UPDATE inbox_items SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", item.id);
    assert.equal(hub.listInbox({ projectPath: dir }).length, 0); // gone from list even though sweepExpiredInbox never ran
  });
});

test("inbox TTL env guards NaN/zero/negative -> 14 days", async () => {
  await withHub(async (hub, dir) => {
    for (const bad of ["abc", "0", "-5", "3.5"]) {
      process.env.CORTEX_INBOX_TTL_DAYS = bad;
      const item = hub.addInboxItem({ projectPath: dir, author: "h", message: `ttl ${bad}` });
      const days = Math.round((new Date(item.expiresAt) - new Date(item.createdAt)) / 86400000);
      assert.equal(days, 14);
    }
    delete process.env.CORTEX_INBOX_TTL_DAYS;
  });
});

test("previously-attempted surfaces a superseded fix with its replacement", async () => {
  await withHub(async (hub, dir) => {
    const old = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "naive retry loop", filesChanged: ["r.js"] });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "exponential backoff", filesChanged: ["r.js"], supersedesId: old.id });
    const rows = hub.storage.listSupersededFixes(dir);
    assert.equal(rows[0].summary, "naive retry loop");
    assert.equal(rows[0].supersededBy, "exponential backoff");
  });
});

test("brief prioritizes a previously-attempted fix that touches the files in play", async () => {
  await withHub(async (hub, dir) => {
    // an older, unrelated superseded attempt (would win on recency alone)
    const unrelatedOld = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "tweaked logging format", filesChanged: ["logger.js"] });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "structured logging", filesChanged: ["logger.js"], supersedesId: unrelatedOld.id });
    // an earlier attempt that touches the file the agent is about to edit again
    const relevantOld = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "naive socket retry loop", filesChanged: ["socketHandler.js"] });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "socket exponential backoff", filesChanged: ["socketHandler.js"], supersedesId: relevantOld.id });

    // cold sessions now get a minimal brief with no Previously Attempted section (audit V)
    const noContext = hub.buildBrief({ projectPath: dir });
    assert.doesNotMatch(noContext.text, /Previously Attempted/);

    const withContext = hub.buildBrief({ projectPath: dir, context: { recentFiles: ["src/socketHandler.js"] } });
    const heading = withContext.text.indexOf("Previously Attempted");
    const section = withContext.text.slice(heading, heading + 300);
    assert.match(section, /naive socket retry loop/);
    // the file-relevant attempt should now lead the unrelated, more-recent one
    assert.ok(section.indexOf("naive socket retry loop") < section.indexOf("tweaked logging format"));
  });
});

test("confidence decay ranks a verified fix ahead of an equally-old unverified one", async () => {
  await withHub(async (hub, dir) => {
    const unverified = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "attempted timeout fix", filesChanged: [] });
    const verified = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "confirmed timeout fix", filesChanged: [], verification: "npm test passed" });
    // pin both to the same timestamp (within the brief's max-age window) so recency
    // alone can't explain the ordering
    const same = new Date(Date.now() - 5 * 86400000).toISOString();
    hub.storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id IN (?, ?)").run(same, unverified.id, verified.id);

    const brief = hub.buildBrief({ projectPath: dir, context: { goalText: "the attempted and confirmed timeout fix" } });
    const heading = brief.text.indexOf("Recent Fixes");
    const section = brief.text.slice(heading, heading + 300);
    assert.ok(
      section.indexOf("confirmed timeout fix") < section.indexOf("attempted timeout fix"),
      "verified fix should rank ahead of an equally-old unverified one",
    );
  });
});

test("brief surfaces a same-named fix from another project as Related Elsewhere", async () => {
  await withHub(async (hub, dir) => {
    const other = join(dir, "other");
    hub.storage.insertFix({
      id: crypto.randomUUID(), projectPath: other, agent: "a",
      summary: "Windows path casing broke sqlite identity", filesChanged: ["identity.js"],
    });
    hub.rebuildIndex();

    const noContext = hub.buildBrief({ projectPath: dir });
    // empty sections are elided entirely (no "- none" line), so the section's absence is
    // the proof that no cross-project query ran
    assert.doesNotMatch(noContext.text, /Related Elsewhere:/, "no context terms means no cross-project query is run");

    const withContext = hub.buildBrief({ projectPath: dir, context: { recentFiles: ["src/identity.js"] } });
    assert.match(withContext.text, /Related Elsewhere:[\s\S]*\[other\][\s\S]*Windows path casing/);
  });
});

test("repeated fixes on one file no longer manufacture a lesson", async () => {
  await withHub(async (hub, dir) => {
    // The fragile-file generator counted fix RECORDS, which duplicate captures inflate 2-6x
    // against git (SETUP.md: 92 records, 14 commits). It produced every lesson in the table
    // and none was ever cited, so it is gone. Fixes still capture; they just stop inventing
    // a "lesson" out of an edit count.
    for (const message of [
      "Fixed ordering bug where pinned tasks dropped out. Files changed: src/rank.js. Verification: npm test passed.",
      "Added recency decay weighting so stale records stop crowding new ones. Files changed: src/rank.js. Verification: npm run test:rank green.",
      "Corrected the priority tiebreaker integer overflow for large backlogs. Files changed: src/rank.js. Verification: unit suite passed.",
    ]) {
      assert.equal(hub.captureCandidate({ projectPath: dir, agent: "claude-code", message }).reason, "accepted_fix");
    }
    assert.equal(hub.storage.listLessons(dir).length, 0, "no lesson is manufactured from an edit count");
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /Lessons:/);
    // A lesson written deliberately through the API still stores and still serves.
    hub.storage.insertLesson({ projectPath: dir, statement: "rank.js is single-writer; do not parallelize", status: "open" });
    assert.equal(hub.storage.listLessons(dir).length, 1);
  });
});
