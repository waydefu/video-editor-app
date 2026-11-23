import { describe, expect, it } from "vitest";
import { ProcessFailure, runProcess } from "../src/main/services/process-runner";

describe("runProcess", () => {
  it("returns stdout for normal output", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(result.stdout).toBe("ok");
  });

  it("rejects with ProcessFailure when stdout exceeds the byte limit", async () => {
    // "字" is 3 bytes in UTF-8, so 400 chars is 1200 bytes: over a 1000-byte limit but under 1000 chars.
    const script = "process.stdout.write('字'.repeat(400))";
    await expect(
      runProcess(process.execPath, ["-e", script], undefined, { maxStdoutBytes: 1000 }),
    ).rejects.toMatchObject({
      name: "ProcessFailure",
      message: "媒體工具輸出過大。",
      exitCode: null,
    });
    await expect(
      runProcess(process.execPath, ["-e", script], undefined, { maxStdoutBytes: 1000 }),
    ).rejects.toBeInstanceOf(ProcessFailure);
  });

  it("rejects with AbortError when the signal has already timed out", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("kills a running process when the timeout fires", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], AbortSignal.timeout(300)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
