import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc";
import { ProjectStore } from "../src/main/services/project-store";

const mock = vi.hoisted(() => ({ handlers: new Map<string, Function>(), root: "", output: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mock.root, getAppMetrics: () => [] },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  clipboard: {},
  shell: {},
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: mock.output }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [mock.output] }),
  },
  ipcMain: { handle: (channel: string, listener: Function) => mock.handlers.set(channel, listener) },
}));

const roots: string[] = [];

afterEach(async () => {
  mock.handlers.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(override?: (args: any[]) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-admission-"));
  roots.push(root);
  mock.root = root;
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  const args: any[] = new Array(27).fill({});
  args[0] = store;
  args[16] = { getLastDirectory: () => root, rememberDirectory: async () => {} };
  args[24] = { setHandlers: () => {}, resetProject: () => {}, setProjectName: () => {} };
  args[25] = { setStatusListener: () => {} };
  override?.(args);
  registerIpc(...(args as Parameters<typeof registerIpc>));
  const invoke = (name: string, ...a: unknown[]) =>
    mock.handlers.get(name)!({ sender: { once: () => {}, removeListener: () => {}, isDestroyed: () => false } }, ...a);
  mock.output = path.join(root, "picked.mp4");
  return { store, root, invoke };
}

it("PR-A06 job first: a project switch is refused while an import is admitted, and allowed after it finishes", async () => {
  const gate = deferred<unknown>();
  const entered = deferred<void>();
  const { invoke } = await setup((args) => {
    args[1] = {
      importSelected: () => {
        entered.resolve();
        return gate.promise;
      },
    };
  });
  const importing = invoke("source:choose-files");
  await entered.promise;
  await expect(invoke("project:new")).rejects.toThrow(/作業正在進行/);
  gate.resolve({
    cancelled: false,
    addedCount: 0,
    duplicateCount: 0,
    unsupportedCount: 0,
    errors: [],
    addedAssetIds: [],
  });
  await importing;
  await expect(invoke("project:new")).resolves.toBeDefined();
});

it("PR-A06 switch first: an import started while New Project runs is refused", async () => {
  const { store, invoke } = await setup((args) => {
    args[1] = { importSelected: async () => ({ cancelled: false, addedCount: 0 }) };
  });
  const gate = deferred<unknown>();
  const newProjectSpy = vi.spyOn(store, "newProject").mockImplementation(() => gate.promise as never);
  const switching = invoke("project:new");
  await vi.waitFor(() => expect(newProjectSpy).toHaveBeenCalled());
  await expect(invoke("source:choose-files")).rejects.toThrow(/正在切換/);
  gate.resolve({ project: store.getProject(), filePath: undefined });
  await switching;
});

it("PR-A06 releases the admission gate when the import fails", async () => {
  const { invoke } = await setup((args) => {
    args[1] = { importSelected: async () => Promise.reject(new Error("boom")) };
  });
  await expect(invoke("source:choose-files")).rejects.toThrow("boom");
  await expect(invoke("project:new")).resolves.toBeDefined();
});
