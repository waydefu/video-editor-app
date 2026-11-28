import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputHistoryStore } from "../src/main/services/output-history";
import type { MediaProbe } from "../src/main/services/media-probe";

const roots: string[] = [];

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent preview output history", () => {
  it("persists completed and cancelled playable renders across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-"));
    roots.push(root);
    const completePath = path.join(root, "河內 正片 preview.mp4");
    const cancelledPath = path.join(root, "取消後短片.mp4");
    await writeFile(completePath, "complete-mp4");
    await writeFile(cancelledPath, "short-mp4");
    const first = new OutputHistoryStore(path.join(root, "app-data"));
    await first.initialize();
    await first.registerRender(
      {
        jobId: "render-complete",
        outputPath: completePath,
        sizeBytes: 12,
        expectedDurationMs: 20_000,
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "CONCAT",
        includedIntroSegmentCount: 2,
      },
      "河內",
    );
    await first.registerRender(
      {
        jobId: "render-cancelled",
        outputPath: cancelledPath,
        sizeBytes: 9,
        expectedDurationMs: 2_000,
        plannedDurationMs: 20_000,
        transitionSeconds: 0.3,
        resolution: "360P",
        purpose: "CONCAT",
        cancelled: true,
      },
      "河內",
    );

    const reopened = new OutputHistoryStore(path.join(root, "app-data"));
    await reopened.initialize();
    expect(await reopened.snapshot()).toMatchObject({
      schemaVersion: 1,
      outputs: [
        { jobId: "render-cancelled", exists: true, cancelled: true },
        { jobId: "render-complete", exists: true, includedIntroSegmentCount: 2, projectName: "河內" },
      ],
    });
  });

  it("removes only the index record and never changes or deletes the MP4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-safe-"));
    roots.push(root);
    const outputPath = path.join(root, "含 中文 空格.mp4");
    await writeFile(outputPath, "irreplaceable-preview");
    const before = await sha256(outputPath);
    const store = new OutputHistoryStore(path.join(root, "app-data"));
    await store.initialize();
    await store.registerRender({
      jobId: "safe-record",
      outputPath,
      sizeBytes: 21,
      expectedDurationMs: 1_000,
      transitionSeconds: 0.3,
      resolution: "360P",
      purpose: "CONCAT",
    });
    expect((await store.removeRecord("safe-record")).outputs).toEqual([]);
    expect((await stat(outputPath)).isFile()).toBe(true);
    expect(await sha256(outputPath)).toBe(before);
  });

  it("imports a previously rendered MP4 once and keeps an offline record visible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-import-"));
    roots.push(root);
    const outputPath = path.join(root, "以前的 預覽檔.mp4");
    await writeFile(outputPath, "existing-mp4");
    const probe = {
      probe: vi.fn(async () => ({
        width: 1280,
        height: 720,
        displayWidth: 1280,
        displayHeight: 720,
        durationMs: 8_500,
        videoCodec: "h264",
        audioCodec: "aac",
      })),
    } as unknown as MediaProbe;
    const store = new OutputHistoryStore(path.join(root, "app-data"), probe);
    await store.initialize();
    const imported = await store.importExisting([outputPath, outputPath]);
    expect(imported).toMatchObject({ addedCount: 1, duplicateCount: 1, errors: [] });
    expect(imported.history.outputs[0]).toMatchObject({
      fileName: "以前的 預覽檔.mp4",
      origin: "IMPORTED_EXISTING",
      purpose: "UNKNOWN",
      resolution: "720P",
      exists: true,
    });
    await rm(outputPath);
    const offline = await store.snapshot();
    expect(offline.outputs[0]).toMatchObject({ exists: false, fileName: "以前的 預覽檔.mp4" });
    await expect(store.get(offline.outputs[0].jobId)).rejects.toThrow(/移動、刪除或離線/);
  });

  it("deduplicates overlapping imports when both media probes finish before commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-concurrent-"));
    roots.push(root);
    const outputPath = path.join(root, "same.mp4");
    await writeFile(outputPath, "existing media");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = {
      probe: vi.fn(async () => {
        await barrier;
        return { width: 1280, height: 720, durationMs: 1_000, videoCodec: "h264" };
      }),
    };
    const store = new OutputHistoryStore(path.join(root, "app-data"), probe as unknown as MediaProbe);
    await store.initialize();

    const first = store.importExisting([outputPath]);
    const second = store.importExisting([outputPath]);
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all([first, second]);

    expect(results.reduce((total, result) => total + result.addedCount, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.duplicateCount, 0)).toBe(1);
    expect((await store.snapshot()).outputs).toHaveLength(1);
    const reopened = new OutputHistoryStore(path.join(root, "app-data"));
    await reopened.initialize();
    expect((await reopened.snapshot()).outputs).toHaveLength(1);
  });
});

describe("output file identity (R2-05)", () => {
  const probe = {
    probe: vi.fn(async () => ({
      width: 640,
      height: 360,
      displayWidth: 640,
      displayHeight: 360,
      durationMs: 20_000,
      videoCodec: "h264",
    })),
  } as unknown as MediaProbe;

  async function registeredStore(name: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-identity-"));
    roots.push(root);
    const outputPath = path.join(root, name);
    await writeFile(outputPath, "original bytes");
    const store = new OutputHistoryStore(path.join(root, "app-data"), probe);
    await store.initialize();
    await store.registerRender(
      {
        jobId: "identity-job",
        outputPath,
        sizeBytes: 14,
        expectedDurationMs: 20_000,
        transitionSeconds: 0.3,
        resolution: "360P",
        purpose: "CONCAT",
      },
      "Original project",
      "original-id",
    );
    return { root, outputPath, store };
  }

  it("marks a same-size replacement CHANGED and refuses it as a trusted upload source", async () => {
    const { outputPath, store } = await registeredStore("replaced.mp4");
    const before = await stat(outputPath);
    await writeFile(outputPath, "replaced bytes");
    // Restore the original timestamp so only the content fingerprint can detect the swap.
    await utimes(outputPath, before.atime, before.mtime);

    expect(await store.get("identity-job")).toMatchObject({
      identityState: "CHANGED",
      successful: false,
      exists: true,
      projectName: "Original project",
    });
    await expect(store.getForUpload("identity-job")).rejects.toThrow(/已與登錄時不同/);
    expect(await readFile(outputPath, "utf8")).toBe("replaced bytes");
  });

  it("reports a size or timestamp change in the snapshot without reading the file", async () => {
    const { outputPath, store } = await registeredStore("resized.mp4");
    await writeFile(outputPath, "much longer replacement bytes");
    expect((await store.snapshot()).outputs[0]).toMatchObject({ identityState: "CHANGED", successful: false });
  });

  it("keeps an unchanged output verified and upload-ready", async () => {
    const { store } = await registeredStore("unchanged.mp4");
    expect(await store.get("identity-job")).toMatchObject({ identityState: "VERIFIED", successful: true });
    expect(await store.getForUpload("identity-job")).toMatchObject({ identityState: "VERIFIED" });
    expect((await store.snapshot()).outputs[0]).toMatchObject({ identityState: "VERIFIED" });
  });

  it("lists legacy entries without identity as UNVERIFIED and openable but not upload-ready", async () => {
    const { root, store } = await registeredStore("legacy.mp4");
    const raw = JSON.parse(await readFile(store.historyPath, "utf8"));
    for (const item of raw.outputs) delete item.identity;
    await writeFile(store.historyPath, JSON.stringify(raw));

    const legacy = new OutputHistoryStore(path.join(root, "app-data"), probe);
    await legacy.initialize();
    expect((await legacy.snapshot()).outputs[0]).toMatchObject({ identityState: "UNVERIFIED", exists: true });
    expect(await legacy.get("identity-job")).toMatchObject({ identityState: "UNVERIFIED", exists: true });
    await expect(legacy.getForUpload("identity-job")).rejects.toThrow(/沒有檔案身分資料/);
  });

  it("records a fresh identity when a changed file is removed and chosen again", async () => {
    const { outputPath, store } = await registeredStore("rechosen.mp4");
    await writeFile(outputPath, "replaced bytes");
    await store.removeRecord("identity-job");
    const result = await store.importExisting([outputPath]);
    expect(result).toMatchObject({ addedCount: 1, errors: [] });
    const [reimported] = result.history.outputs;
    expect(await store.getForUpload(reimported.jobId)).toMatchObject({ identityState: "VERIFIED" });
    expect(await readFile(outputPath, "utf8")).toBe("replaced bytes");
  });
});
