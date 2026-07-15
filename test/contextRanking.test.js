import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectBrief } from "../src/brief.js";

function task(id, title, overrides = {}) {
  return {
    id,
    title,
    status: "ready",
    priority: "normal",
    relatedFiles: [],
    ...overrides,
  };
}

function brief(overrides = {}) {
  return buildProjectBrief({
    projectPath: "C:\\repo",
    profile: null,
    tasks: [],
    research: [],
    fixes: [],
    sessions: [],
    context: {},
    ...overrides,
  });
}

test("ignores generic path tokens when ranking contextual tasks", () => {
  const result = brief({
    tasks: [
      task("generic", "Refactor src utilities"),
      task("match", "Repair unrelated data handling"),
    ],
    context: { recentFiles: ["src/unrelated.js"] },
  });

  assert.deepEqual(result.tasks.map(({ id }) => id), ["match", "generic"]);
});

test("preserves urgent and in-progress work outside contextual result cap", () => {
  const matches = Array.from({ length: 7 }, (_, index) =>
    task(`match-${index}`, `Repair close fill path ${index}`, { priority: "high" }),
  );
  const result = brief({
    tasks: [
      ...matches,
      task("urgent", "Unrelated safety gate", { priority: "urgent" }),
      task("active", "Active unrelated work", { status: "in_progress" }),
    ],
    context: { branch: "fix/close-fill" },
  });

  assert.equal(result.tasks.some(({ id }) => id === "urgent"), true);
  assert.equal(result.tasks.some(({ id }) => id === "active"), true);
});

test("uses stable ordering for equally ranked records", () => {
  const tasks = [task("first", "Alpha"), task("second", "Beta")];
  const first = brief({ tasks, context: { branch: "feature/no-match" } });
  const second = brief({ tasks, context: { branch: "feature/no-match" } });

  assert.deepEqual(first.tasks.map(({ id }) => id), second.tasks.map(({ id }) => id));
});

test("includes relevant memories only when supplied", () => {
  const absent = brief();
  const present = brief({
    context: {
      relevantMemories: [{ name: "close-fill", description: "Broker close-path evidence" }],
    },
  });

  assert.doesNotMatch(absent.text, /Relevant Memories:/);
  assert.match(present.text, /\[close-fill\] Broker close-path evidence/);
});
