// Kill a spawned child AND its process tree. Agent/verify/review/distill children are
// spawned with shell:true, so on Windows `child` is cmd.exe — a bare child.kill() reaps
// only the wrapper and orphans the real claude/node grandchild, which keeps running (and
// billing) invisibly. taskkill /T walks the tree. Off-Windows (and for pid-less fakes in
// tests) plain kill() is correct: the shell forwards its own death via process groups.
import { execFileSync } from "node:child_process";

export function killChild(child, { run = execFileSync } = {}) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
      return;
    } catch { /* tree already gone or taskkill unavailable — fall through */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}
