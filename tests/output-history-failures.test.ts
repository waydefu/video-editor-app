import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ failCommit: false, failBackup: false }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (
        (controls.failCommit && String(to).endsWith("preview-output-history.json")) ||
        (controls.failBackup && String(to).includes(".invalid-"))
      ) {
        throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      }
      return actual.rename(from, to);
    }),
  };
});

import { OutputHistoryStore } from "../src/main/services/output-history";

const roots: string[] = [];
beforeEach(() => {
  controls.failCommit = false;
  controls.failBackup = false;
});
afterEach(async () => {
  controls.failCommit = false;
  controls.failBackup = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "output-history-failure-"));
  roots.push(root);
  const appRoot = path.join(root, "app-data");
  const videoPath = path.join(root, "completed.mp4");
  await writeFile(videoPath, "irreplaceable output");
  return { root, appRoot, videoPath };
}

describe("OutputHistoryStore failure boundaries", () => {
  it("does not commit a failed update in memory or on disk and cleans its partial file", async () => {
    const { appRoot, videoPath } = await sandbox();
    const store = new OutputHistoryStore(appRoot);
    await store.initialize();
    const record = (jobId: string) => ({
      jobId,
      outputPath: videoPath,
      sizeBytes: 20,
      expectedDurationMs: 1_000,
      transitionSeconds: 0.3,
      resolution: "360P" as const,
      purpose: "CONCAT" as const,
    });
    await store.registerRender(record("first-render"));
    const persisted = await readFile(store.historyPath, "utf8");

    controls.failCommit = true;
    await expect(store.registerRender(record("second-render"))).rejects.toMatchObject({ code: "EACCES" });
    controls.failCommit = false;

    expect((await store.snapshot()).outputs.map((item) => item.jobId)).toEqual(["first-render"]);
    expect(await readFile(store.historyPath, "utf8")).toBe(persisted);
    expect((await readdir(path.dirname(store.historyPath))).filter((name) => name.endsWith(".partial"))).toEqual([]);

    const reopened = new OutputHistoryStore(appRoot);
    await reopened.initialize();
    expect((await reopened.snapshot()).outputs.map((item) => item.jobId)).toEqual(["first-render"]);
  });

  it("does not overwrite invalid history when the safety backup cannot be made", async () => {
    const { appRoot } = await sandbox();
    const historyPath = path.join(appRoot, "settings", "preview-output-history.json");
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(historyPath, "{not valid JSON");
    controls.failBackup = true;
    await expect(new OutputHistoryStore(appRoot).initialize()).rejects.toMatchObject({ code: "EACCES" });
    controls.failBackup = false;
    expect(await readFile(historyPath, "utf8")).toBe("{not valid JSON");
  });

  it("retains the original corrupt bytes in an invalid backup before starting fresh", async () => {
    const { appRoot } = await sandbox();
    const historyPath = path.join(appRoot, "settings", "preview-output-history.json");
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(historyPath, "{not valid JSON");
    const store = new OutputHistoryStore(appRoot);
    await store.initialize();

    const files = await readdir(path.dirname(historyPath));
    const backupName = files.find((name) => name.startsWith("preview-output-history.json.invalid-"));
    expect(backupName).toBeDefined();
    expect(await readFile(path.join(path.dirname(historyPath), backupName!), "utf8")).toBe("{not valid JSON");
    expect((await store.snapshot()).outputs).toEqual([]);
  });
});
