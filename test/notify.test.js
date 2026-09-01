import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTelegramChannel, createNotifier } from "../src/notify.js";

test("loadTelegramChannel reads the claude channel config; missing/partial config disables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-tg-"));
  try {
    assert.equal(loadTelegramChannel(dir), null); // nothing there yet
    await writeFile(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    assert.equal(loadTelegramChannel(dir), null); // token alone is not enough
    await writeFile(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["111222333"] }));
    assert.deepEqual(loadTelegramChannel(dir), { token: "123:abc", chatId: "111222333" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("notifier debounces per key and never throws through", async () => {
  const sent = [];
  let clock = 0;
  const notifier = createNotifier({
    channel: { token: "t", chatId: "c" },
    sendImpl: async (text) => { sent.push(text); },
    minIntervalMs: 60_000,
    now: () => clock,
  });

  assert.equal(await notifier.push("run-fail:p1", "run one failed"), true);
  assert.equal(await notifier.push("run-fail:p1", "run two failed"), false); // same key, same minute
  assert.equal(await notifier.push("needs-you", "review landed"), true);     // different key passes
  clock += 60_001;
  assert.equal(await notifier.push("run-fail:p1", "run three failed"), true); // window elapsed
  assert.deepEqual(sent, ["run one failed", "review landed", "run three failed"]);

  // a throwing sender reports false but never propagates
  const angry = createNotifier({ channel: { token: "t", chatId: "c" }, sendImpl: async () => { throw new Error("telegram down"); } });
  assert.equal(await angry.push("k", "msg"), false);
});

test("no channel and no sender means every push is a silent no-op", async () => {
  const notifier = createNotifier({ channel: null });
  assert.equal(notifier.enabled, false);
  assert.equal(await notifier.push("k", "msg"), false);
});

test("pushDocument posts the file via sendDocument and never throws", async () => {
  const calls = [];
  const notifier = createNotifier({
    channel: { token: "tok", chatId: "42" },
    sendImpl: async () => {},
    sendDocumentImpl: async (path, caption) => { calls.push({ path, caption }); },
  });
  const ok = await notifier.pushDocument("reports/eod/2026-08-07.html", "Evening brief");
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ path: "reports/eod/2026-08-07.html", caption: "Evening brief" }]);
});

test("pushDocument is a no-op without a channel", async () => {
  const notifier = createNotifier({ channel: null });
  assert.equal(await notifier.pushDocument("x.html", "cap"), false);
});

test("pushDocument reports false rather than throwing when sendDocumentImpl throws", async () => {
  const notifier = createNotifier({
    channel: { token: "tok", chatId: "42" },
    sendImpl: async () => {},
    sendDocumentImpl: async () => { throw new Error("telegram down"); },
  });
  assert.equal(await notifier.pushDocument("x.html", "cap"), false);
});
