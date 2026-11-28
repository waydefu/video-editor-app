import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const typescriptPackage = require.resolve("typescript/package.json");
const tscBin = join(dirname(typescriptPackage), require(typescriptPackage).bin.tsc);
const compiler = spawn(process.execPath, [tscBin, "-p", "tsconfig.main.json"], {
  cwd: appRoot,
  stdio: "inherit",
  windowsHide: true,
});
const compilerExit = await new Promise((resolve, reject) => {
  compiler.once("error", reject);
  compiler.once("exit", (code) => resolve(code ?? 1));
});
if (compilerExit !== 0) process.exit(compilerExit);

const host = "127.0.0.1";
const port = 5173;
const vite = await createServer({ root: appRoot, server: { host, port, strictPort: true } });
await vite.listen();
vite.printUrls();

const electronProcess = spawn(require("electron"), [appRoot], {
  cwd: appRoot,
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://${host}:${port}` },
  stdio: "inherit",
});

let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (electronProcess.exitCode === null && electronProcess.signalCode === null) electronProcess.kill();
  try {
    await vite.close();
  } finally {
    process.exitCode = exitCode;
  }
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
electronProcess.once("error", (error) => {
  console.error(error);
  void stop(1);
});
electronProcess.once("exit", (code) => void stop(code ?? 1));
