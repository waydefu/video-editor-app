import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc";
import { MediaProbe } from "../src/main/services/media-probe";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

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

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-import-cancel-"));
  roots.push(root);
  return root;
}

// R1-06: the last file's ADDING step is aborted. The commit point must refuse it instead of committing.
it("R1-06: an abort during the final ADDING step commits nothing and reports cancelled", async () => {
  const root = await makeRoot();
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  const file = path.join(root, "one.mp4");
  await writeFile(file, "original");
  const controller = new AbortController();
  const result = await new SourceService(store, new MediaProbe()).importSelected(
    [file],
    controller.signal,
    (progress) => {
      if (progress.phase === "ADDING") controller.abort();
    },
  );
  expect(result.cancelled).toBe(true);
  expect(result.addedCount).toBe(0);
  expect(store.getProject().sources).toHaveLength(0);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function setupIpc(importSelected: (files: string[], signal: AbortSignal) => Promise<unknown>) {
  const root = await makeRoot();
  mock.root = root;
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  const args: any[] = new Array(27).fill({});
  args[0] = store;
  args[1] = { importSelected };
  args[16] = { getLastDirectory: () => root, rememberDirectory: async () => {} };
  args[24] = { setHandlers: () => {}, resetProject: () => {}, setProjectName: () => {} };
  args[25] = { setStatusListener: () => {} };
  registerIpc(...(args as Parameters<typeof registerIpc>));
  mock.output = path.join(root, "picked.mp4");
  return (name: string, ...a: unknown[]) =>
    mock.handlers.get(name)!({ sender: { once: () => {}, removeListener: () => {}, isDestroyed: () => false } }, ...a);
}

// R2-09: the first import's finally must not clear the controller that now belongs to the second import.
it("R2-09: cancel-import targets the second import after the first import finishes", async () => {
  const signals: AbortSignal[] = [];
  const finishes: Array<() => void> = [];
  const invoke = await setupIpc(
    (_files, signal) =>
      new Promise((resolve) => {
        signals.push(signal);
        finishes.push(() =>
          resolve({ cancelled: false, addedCount: 0, duplicateCount: 0, unsupportedCount: 0, errors: [] }),
        );
      }),
  );
  const first = invoke("source:choose-files");
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  const second = invoke("source:choose-files");
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  finishes[0]();
  await first;
  await invoke("source:cancel-import");
  expect(signals[1].aborted).toBe(true);
  finishes[1]();
  await second;
});

it("R2-09: a finished import does not leave a controller that a later cancel can target", async () => {
  const gate = deferred();
  const invoke = await setupIpc(async () => {
    await gate.promise;
    return { cancelled: false, addedCount: 0, duplicateCount: 0, unsupportedCount: 0, errors: [] };
  });
  const pending = invoke("source:choose-files");
  gate.resolve();
  await pending;
  // Cancelling after completion must be a harmless no-op.
  await expect(invoke("source:cancel-import")).resolves.toBeUndefined();
});
