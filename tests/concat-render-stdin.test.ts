import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const fakeChildren = vi.hoisted(() => [] as unknown[]);
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: () => {
      // stdin.write() fails asynchronously with EPIPE, like a pipe to an FFmpeg that already exited.
      const stdin = Object.assign(new EventEmitter(), {
        write: () => {
          setImmediate(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
          return true;
        },
        end: () => undefined,
      });
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      fakeChildren.push(child);
      return child;
    },
  };
});

import { runFfmpegWithProgress } from "../src/main/services/concat-render";

describe("runFfmpegWithProgress stdin handling", () => {
  it("ignores an asynchronous EPIPE when asking FFmpeg to quit", async () => {
    const controller = new AbortController();
    const run = runFfmpegWithProgress("ffmpeg", [], 1000, controller.signal, () => undefined);
    const child = fakeChildren[0] as EventEmitter & { stdin: EventEmitter };
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    controller.abort();
    // Without an stdin error listener, emitting EPIPE would throw here as an uncaught exception.
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.emit("exit", 0);
    await expect(run).resolves.toMatchObject({ cancelled: true });
  });
});
