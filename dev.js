#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const procs = [
  { label: "api", cmd: "npm run start" },
  { label: "ui ", cmd: "npm run web:dev" },
];

const colors = { api: "\x1b[36m", "ui ": "\x1b[35m" };
const reset = "\x1b[0m";

const children = procs.map(({ label, cmd }) => {
  const child = spawn(cmd, { stdio: "pipe", cwd: root, shell: true });
  const prefix = `${colors[label]}[${label}]${reset} `;
  child.stdout.on("data", (d) => process.stdout.write(prefix + d.toString().replace(/\n(?!$)/g, `\n${prefix}`)));
  child.stderr.on("data", (d) => process.stderr.write(prefix + d.toString().replace(/\n(?!$)/g, `\n${prefix}`)));
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    for (const c of children) try { c.kill(); } catch {}
    process.exit(code ?? 1);
  });
  return child;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of children) try { c.kill(); } catch {}
    process.exit(0);
  });
}
