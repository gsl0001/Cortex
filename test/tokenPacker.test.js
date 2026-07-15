import test from "node:test";
import assert from "node:assert/strict";
import { packContext } from "../src/tokenPacker.js";

test("packs diverse evidence within a strict token budget", () => {
  const results = [
    { id: "a", recordType: "fix", title: "Close fix", excerpt: "A".repeat(80), score: 1 },
    { id: "b", recordType: "fix", title: "Close fix", excerpt: "A".repeat(80), score: .9 },
    { id: "c", recordType: "research", title: "Root cause", excerpt: "Different evidence", score: .8 },
  ];
  const packed = packContext(results, { maxTokens: 45, estimateTokens: (text) => Math.ceil(text.length / 4) });

  assert.equal(packed.usedTokens <= 45, true);
  assert.equal(packed.citations.some(({ id }) => id === "a"), true);
  assert.equal(packed.citations.some(({ id }) => id === "b"), false);
  assert.equal(packed.text.includes("Root cause"), true);
});
