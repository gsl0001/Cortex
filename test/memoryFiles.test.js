import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRelevantMemories } from "../src/memoryFiles.js";

test("loads ranked memories from project-configured directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-files-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "close.md"), `---
name: close-fill
description: Broker close reconciliation evidence
tags: [broker, close, fill]
---
body
`);
    await writeFile(join(second, "reports.md"), `---
name: report-builder
description: Export reliability
tags: [reports, export]
---
body
`);

    const result = loadRelevantMemories([first, second, join(root, "missing")], ["close", "fill"]);

    assert.deepEqual(result.map(({ name }) => name), ["close-fill"]);
    assert.equal(result[0].score, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
