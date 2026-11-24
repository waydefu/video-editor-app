import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const processControl = vi.hoisted(() => ({ child: null as unknown }));
vi.mock("node:child_process", () => ({
  spawn: () => processControl.child,
}));

import { runProcess } from "../src/main/services/process-runner";

describe("runProcess stdio drain", () => {
  it("waits for close after exit so late stdout/stderr bytes are not lost", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    processControl.child = child;
    const result = runProcess("fake-media-tool", []);

    // Node emits "exit" before all data is necessarily read from the pipes.
    child.emit("exit", 0);
    child.stdout.end("trailing media metadata");
    child.stderr.end("final diagnostic");
    child.emit("close", 0);

    await expect(result).resolves.toEqual({
      stdout: "trailing media metadata",
      stderr: "final diagnostic",
    });
  });
});
