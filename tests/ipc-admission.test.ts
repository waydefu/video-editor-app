import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/main/services/project-store";
import { registerIpc } from "../src/main/ipc";

const mock = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  root: "",
  output: "",
  // Optional override that lets a test hold a render inside its preflight.
  captureSystemResources: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("electron", () => ({
  app: { getPath: () => mock.root, getAppMetrics: () => [] },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  clipboard: {},
  shell: {},
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: mock.output }) },
  ipcMain: { handle: (channel: string, listener: Function) => mock.handlers.set(channel, listener) },
}));

vi.mock("../src/main/services/system-resource", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    captureSystemResources: (...args: unknown[]) =>
      mock.captureSystemResources ? mock.captureSystemResources(...args) : actual.captureSystemResources(...args),
  };
});

const roots: string[] = [];

afterEach(async () => {
  mock.handlers.clear();
  mock.captureSystemResources = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Registers the real IPC handlers with mocked collaborators. Argument positions
 * follow the registerIpc signature in src/main/ipc.ts.
 */
async function setup(override: (args: any[]) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-ipc-admission-"));
  roots.push(root);
  mock.root = root;
  mock.output = path.join(root, "test.mp4");
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  const args: any[] = new Array(27).fill({});
  args[0] = store;
  args[16] = {
    getLastDirectory: () => root,
    rememberDirectory: async () => {},
    snapshot: () => ({ renderDefaults: {} }),
  };
  args[24] = { setHandlers: () => {}, resetProject: () => {}, setProjectName: () => {} };
  args[25] = { setStatusListener: () => {} };
  override(args);
  registerIpc(...(args as Parameters<typeof registerIpc>));
  const invoke = (name: string, ...a: unknown[]) =>
    mock.handlers.get(name)!({ sender: { once: () => {}, removeListener: () => {}, isDestroyed: () => false } }, ...a);
  return { invoke };
}

const outputOk = { purpose: "CONCAT", outputPath: "mock.mp4" };
const uploadOk = { thumbnailStatus: "FAILED" };

describe("R1-16 YouTube upload admission", () => {
  it("admits only one upload while the output lookup is pending", async () => {
    let resolveOutput!: (value: unknown) => void;
    const outputPromise = new Promise((resolve) => (resolveOutput = resolve));
    const upload = vi.fn(async () => uploadOk);
    const get = vi.fn(() => outputPromise);
    const { invoke } = await setup((args) => {
      args[13] = { upload };
      args[15] = { get, getForUpload: get };
      args[20] = { acquire: () => () => {} };
      args[26] = { cancel: () => {}, notifySuccess: () => {} };
    });

    const one = invoke("youtube:upload", { jobId: "one" });
    const two = invoke("youtube:upload", { jobId: "two" });
    const twoOutcome = two.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    resolveOutput(outputOk);

    expect(await twoOutcome).toContain("已有 YouTube 上傳正在進行中");
    await one;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("releases admission after a validation failure so the next upload can run", async () => {
    const upload = vi.fn(async () => uploadOk);
    const get = vi
      .fn()
      .mockResolvedValueOnce({ purpose: "CLIP", outputPath: "clip.mp4" })
      .mockResolvedValueOnce(outputOk);
    const { invoke } = await setup((args) => {
      args[13] = { upload };
      args[15] = { get, getForUpload: get };
      args[20] = { acquire: () => () => {} };
      args[26] = { cancel: () => {}, notifySuccess: () => {} };
    });

    await expect(invoke("youtube:upload", { jobId: "clip" })).rejects.toThrow("單一時間段預覽");
    await expect(invoke("youtube:upload", { jobId: "main" })).resolves.toEqual(uploadOk);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("releases admission after an upload error so a retry can run", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(uploadOk);
    const { invoke } = await setup((args) => {
      args[13] = { upload };
      args[15] = { get: async () => outputOk, getForUpload: async () => outputOk };
      args[20] = { acquire: () => () => {} };
      args[26] = { cancel: () => {}, notifySuccess: () => {} };
    });

    await expect(invoke("youtube:upload", { jobId: "main" })).rejects.toThrow("network down");
    await expect(invoke("youtube:upload", { jobId: "main" })).resolves.toEqual(uploadOk);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("does not start the upload when cancelled during the output lookup", async () => {
    let resolveOutput!: (value: unknown) => void;
    const outputPromise = new Promise((resolve) => (resolveOutput = resolve));
    const upload = vi.fn(async () => uploadOk);
    const { invoke } = await setup((args) => {
      args[13] = { upload };
      args[15] = { get: () => outputPromise, getForUpload: () => outputPromise };
      args[20] = { acquire: () => () => {} };
      args[26] = { cancel: () => {}, notifySuccess: () => {} };
    });

    const one = invoke("youtube:upload", { jobId: "one" }).then(
      () => "resolved",
      (error: Error) => error.name,
    );
    await invoke("youtube:cancel-upload");
    resolveOutput(outputOk);

    expect(await one).toBe("AbortError");
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("R2-08 render benchmark admission", () => {
  it("runs at most one benchmark and rejects a second overlapping call", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => (finish = resolve));
    // Only the first call holds; a second, unguarded call resolves at once so the failure is immediate.
    const run = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
    const { invoke } = await setup((args) => {
      args[20] = { acquire: () => () => {} };
      args[22] = { run };
    });

    const one = invoke("render-benchmark:run");
    const two = invoke("render-benchmark:run").then(
      () => "resolved",
      (error: Error) => error.message,
    );

    expect(await two).toContain("效能測試");
    expect(run).toHaveBeenCalledTimes(1);
    finish({});
    await one;
  });

  it("refuses remote render preparation while a benchmark holds the render admission", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => (finish = resolve));
    const run = vi.fn(() => pending);
    const { invoke } = await setup((args) => {
      args[20] = { acquire: () => () => {} };
      args[22] = { run };
    });

    const one = invoke("render-benchmark:run");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Remote prepare is gated by the same admission and must refuse while the benchmark runs.
    await expect(invoke("remote-control:prepare-render", { outputToken: "x" })).rejects.toThrow("目前不能準備遠端轉檔");
    finish({});
    await one;
  });

  it("blocks a benchmark while a render is still in its preflight", async () => {
    let releaseHold!: (reason: Error) => void;
    mock.captureSystemResources = () =>
      new Promise<never>((_resolve, reject) => {
        releaseHold = reject;
      });
    const run = vi.fn(async () => ({}));
    const { invoke } = await setup((args) => {
      args[20] = { acquire: () => () => {} };
      args[22] = { run };
    });
    const token = (await invoke("concat:choose-output", "test")) as { token: string };

    const render = invoke("concat:start", {
      outputToken: token.token,
      resolution: "360P",
      orderedAssetIds: [],
      transitionSeconds: 0.3,
    }).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(releaseHold).toBeDefined());

    await expect(invoke("render-benchmark:run")).rejects.toThrow("效能測試");
    expect(run).not.toHaveBeenCalled();
    releaseHold(new Error("preflight stopped by test"));
    expect(await render).toContain("preflight stopped by test");
  });

  it("releases benchmark admission after a benchmark failure so a retry can run", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("benchmark failed")).mockResolvedValueOnce({ ok: true });
    const { invoke } = await setup((args) => {
      args[20] = { acquire: () => () => {} };
      args[22] = { run };
    });

    await expect(invoke("render-benchmark:run")).rejects.toThrow("benchmark failed");
    await expect(invoke("render-benchmark:run")).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
