import { describe, expect, it, vi } from "vitest";
import type { BackgroundJobSnapshot } from "../src/shared/domain";

const { bus, exposed } = vi.hoisted(() => ({
  bus: { emitter: undefined as unknown as import("node:events").EventEmitter },
  exposed: {} as Record<string, unknown>,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  bus.emitter = new Emitter();
  return {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => (exposed[name] = api) },
    ipcRenderer: {
      on: (channel: string, handler: (...args: unknown[]) => void) => bus.emitter.on(channel, handler),
      removeListener: (channel: string, handler: (...args: unknown[]) => void) =>
        bus.emitter.removeListener(channel, handler),
      removeAllListeners: (channel: string) => bus.emitter.removeAllListeners(channel),
      invoke: vi.fn(),
      send: vi.fn(),
    },
  };
});

describe("preload background job subscriptions", () => {
  it("unsubscribing one subscriber keeps the other receiving updates", async () => {
    await import("../src/main/preload");
    const api = exposed.sourceApp as {
      onBackgroundJobs(callback: (jobs: BackgroundJobSnapshot[]) => void): () => void;
    };
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = api.onBackgroundJobs(first);
    api.onBackgroundJobs(second);
    const jobs = [{ id: "job-1" }] as BackgroundJobSnapshot[];

    bus.emitter.emit("background:jobs", {}, jobs);
    expect(first).toHaveBeenCalledWith(jobs);
    expect(second).toHaveBeenCalledWith(jobs);

    offFirst();
    bus.emitter.emit("background:jobs", {}, jobs);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(bus.emitter.listenerCount("background:jobs")).toBe(1);
  });
});
