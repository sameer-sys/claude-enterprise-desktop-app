import { spawn } from "node:child_process";

const mode = process.argv[2] || "desktop";
process.env.OPENWORK_DEV_MODE = "1";
if (!process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT) {
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = "9823";
}

const target = mode === "ui" ? "@openwork/app" : "@openwork/desktop";
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const child = spawn(pnpmCmd, ["--filter", target, "dev"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
