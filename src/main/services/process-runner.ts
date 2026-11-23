import { spawn } from "node:child_process";

export class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ProcessFailure";
  }
}

const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export function runProcess(
  executable: string,
  args: string[],
  signal?: AbortSignal,
  options: { cwd?: string; input?: string; maxStdoutBytes?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("工作已取消。", "AbortError"));
      return;
    }

    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const stdoutStream = child.stdout!;
    const stderrStream = child.stderr!;
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    let stdoutBytes = 0;
    let overflowed = false;
    stdoutStream.on("data", (chunk: string) => {
      if (overflowed) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        overflowed = true;
        stdout = "";
        child.kill();
        return;
      }
      stdout += chunk;
    });
    stderrStream.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    if (options.input !== undefined && child.stdin) {
      // The child may exit before reading its input; EPIPE then surfaces as an async stdin error.
      child.stdin.on("error", () => {});
      child.stdin.end(options.input, "utf8");
    }

    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new DOMException("工作已取消。", "AbortError"));
      } else if (overflowed) {
        reject(new ProcessFailure("媒體工具輸出過大。", null, stderr));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new ProcessFailure("媒體工具無法處理此檔案。", code, stderr));
      }
    });
  });
}
