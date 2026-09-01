import test from "node:test";
import assert from "node:assert/strict";
import { extractCaptureFields, normalizeCandidate } from "../src/capturePolicy.js";

// 2026-07 audit: files=["none"] poisoned the recall_useful matcher, lesson promotion, and
// JIT recall. The sanitizer at the single parse point must reject placeholders and strip markup.
test("extractCaptureFields rejects placeholder file tokens", () => {
  const fields = extractCaptureFields(normalizeCandidate({
    message: "Fixed the thing. Files changed: none. Verification: npm test green",
  }));
  assert.deepEqual(fields.filesChanged, []);
  assert.equal(fields.verification, "npm test green");
});

test("extractCaptureFields strips backticks and quotes from file tokens", () => {
  const fields = extractCaptureFields(normalizeCandidate({
    message: "Fixed. Files changed: `src/agentLauncher.js`, \"src/brief.js\", n/a, src/cli.js. Verification: npm test",
  }));
  assert.deepEqual(fields.filesChanged, ["src/agentLauncher.js", "src/brief.js", "src/cli.js"]);
});

test("extractCaptureFields still falls back to recentFiles when no label exists", () => {
  const fields = extractCaptureFields(normalizeCandidate({
    message: "Fixed the flaky watcher.",
    recentFiles: ["src/watcher.js"],
  }));
  assert.deepEqual(fields.filesChanged, ["src/watcher.js"]);
});
