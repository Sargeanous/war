import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const processes = [
  spawn("node", ["server/index.mjs"], { stdio: "inherit", shell: isWindows }),
  spawn("pnpm", ["frontend"], { stdio: "inherit", shell: isWindows }),
];

function shutdown(signal) {
  for (const child of processes) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const child of processes) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      shutdown("SIGTERM");
      process.exit(code);
    }
  });
}
