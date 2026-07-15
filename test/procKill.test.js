import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { killChild } from "../src/procKill.js";

test("killChild tree-kills via taskkill on Windows and falls back to kill() when it fails", () => {
  const calls = [];
  const killed = [];
  const child = { pid: 4242, kill: () => killed.push(4242) };

  killChild(child, { run: (cmd, args) => calls.push([cmd, ...args]) });
  if (process.platform === "win32") {
    assert.deepEqual(calls[0], ["taskkill", "/PID", "4242", "/T", "/F"]);
    assert.equal(killed.length, 0, "taskkill succeeded — no fallback kill");
  } else {
    assert.equal(calls.length, 0);
    assert.deepEqual(killed, [4242]);
  }

  // taskkill unavailable/failed -> plain kill() still reaps the wrapper
  killed.length = 0;
  killChild(child, { run: () => { throw new Error("taskkill not found"); } });
  assert.deepEqual(killed, [4242]);

  // pid-less fakes (unit-test children) and null are safe no-ops via kill()
  killed.length = 0;
  killChild({ kill: () => killed.push("no-pid") }, { run: () => { throw new Error("must not run taskkill without a pid"); } });
  assert.deepEqual(killed, ["no-pid"]);
  killChild(null);
});

// The bug this exists for: agents run under shell:true, so `child` is cmd.exe and a bare
// child.kill() reaps only the wrapper — the real node/claude grandchild keeps running.
test("win32 regression: killChild reaps the shell's grandchild, not just the wrapper", { skip: process.platform !== "win32" }, async () => {
  const child = spawn("node -e \"setTimeout(() => {}, 60000)\"", { shell: true, windowsHide: true, stdio: "ignore" });
  try {
    // wait for cmd.exe to actually spawn the node grandchild
    let grandchild = null;
    for (let attempt = 0; attempt < 20 && !grandchild; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}").ProcessId`],
      { encoding: "utf8", windowsHide: true });
      grandchild = Number(out.trim().split(/\s+/)[0]) || null;
    }
    assert.ok(grandchild, "shell wrapper spawned a grandchild to reap");

    killChild(child);
    // the grandchild must be gone (taskkill /T), not orphaned
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try { process.kill(grandchild, 0); } catch { alive = false; }
    }
    assert.equal(alive, false, `grandchild ${grandchild} still running after killChild`);
  } finally {
    killChild(child); // idempotent cleanup if the assertion path bailed early
  }
});
