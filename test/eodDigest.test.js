import test from "node:test";
import assert from "node:assert/strict";
import { buildDigestPrompt, applyDigest, runDigest } from "../src/eodDigest.js";
import { renderEodText, renderEodHtml } from "../src/eod.js";

const report = () => ({
  date: "2026-08-07",
  generatedAt: "2026-08-07T17:45:00.000Z",
  done: {
    tasks: [{ project_path: "C:/work/demo", title: "shipped thing", evidence: "npm test passed" }],
    fixes: [{ project_path: "C:/work/demo", summary: "raw agent jargon about WAL checkpoints" }],
    decisions: [], research: [], sessions: [],
  },
  needsEyes: { inbox: [], blocked: [{ project_path: "C:/work/demo", title: "stuck thing", block_reason: "missing adb" }], proposals: [], failedRuns: [] },
  verifyQueue: { tasks: [], fixes: [], drift: [] },
  tonight: { open: [{ project_path: "C:/work/demo", title: "open thing", priority: "high" }], staleClaims: [] },
});

test("buildDigestPrompt lists every summarizable item with a stable key", () => {
  const { items, prompt } = buildDigestPrompt(report());
  assert.deepEqual(items.map((i) => i.key), ["t0", "f0", "e0", "o0"]);
  assert.match(prompt, /f0: fix: raw agent jargon about WAL checkpoints/);
  assert.match(prompt, /ONLY a JSON object/);
});

test("applyDigest attaches summaries and the story, ignoring unknown keys", () => {
  const r = report();
  const { items } = buildDigestPrompt(r);
  applyDigest(r, items, { story: "Quiet but productive day.", items: { f0: "Fixed the database sync bug.", zz9: "bogus" } });
  assert.equal(r.done.fixes[0].summary_plain, "Fixed the database sync bug.");
  assert.equal(r.story, "Quiet but productive day.");
  assert.equal(r.done.tasks[0].summary_plain, undefined);
});

test("runDigest merges agent JSON even when wrapped in prose", () => {
  const r = runDigest(report(), {
    runAgent: () => 'Here you go:\n{"story": "Good day.", "items": {"e0": "Waiting on a device to continue."}}\nDone!',
  });
  assert.equal(r.story, "Good day.");
  assert.equal(r.needsEyes.blocked[0].summary_plain, "Waiting on a device to continue.");
});

test("runDigest failure leaves the report intact with digestError set", () => {
  const r = runDigest(report(), { runAgent: () => { throw new Error("claude exited 1: OAuth expired"); } });
  assert.equal(r.story, undefined);
  assert.match(r.digestError, /OAuth expired/);
  assert.equal(r.done.fixes[0].summary, "raw agent jargon about WAL checkpoints");
});

test("renderers prefer plain-English summaries and show the story", () => {
  const r = report();
  r.story = "One fix landed; the blocked task still needs your phone.";
  r.needsEyes.blocked[0].summary_plain = "Waiting on a device to continue.";
  const text = renderEodText(r);
  assert.match(text, /One fix landed; the blocked task still needs your phone\./);
  assert.match(text, /demo — Waiting on a device to continue\./);
  assert.doesNotMatch(text, /missing adb/);
  const html = renderEodHtml(r);
  assert.match(html, /class="story"/);
  assert.match(html, /Waiting on a device to continue\./);
});

test("digestError shows in the HTML footer", () => {
  const r = report();
  r.digestError = "claude exited 1";
  assert.match(renderEodHtml(r), /plain-English digest unavailable \(claude exited 1\)/);
});
