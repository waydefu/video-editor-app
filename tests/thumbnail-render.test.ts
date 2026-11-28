import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { link, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderThumbnail } from "../src/main/services/thumbnail-render";

// "fail": ffmpeg exits 1. "ok": ffmpeg writes a 256-byte image and exits 0. "hang": ffmpeg runs until killed.
const ffmpegMode = vi.hoisted(() => ({ mode: "fail" as "fail" | "ok" | "hang" }));
const spawnedArgs = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: string[]) => {
    spawnedArgs.push(args);
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill: () => {
        setImmediate(() => child.emit("close", null));
        return true;
      },
    });
    if (ffmpegMode.mode === "ok") {
      writeFileSync(args[args.length - 1], Buffer.alloc(256, 1));
      setImmediate(() => child.emit("close", 0));
    } else if (ffmpegMode.mode === "fail") {
      setImmediate(() => child.emit("close", 1));
    }
    return child;
  },
}));

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const cand = {
  sourceTimeMs: 0,
  style: {
    text: "",
    textXPercent: 50,
    textYPercent: 50,
    fontSizePx: 40,
    textColor: "#FFFFFF",
    outlineWidthPx: 1,
    overlayOpacityPercent: 0,
  },
} as never;

describe("thumbnail safety boundary", () => {
  it("rejects non-absolute source paths before invoking ffmpeg", async () => {
    await expect(
      renderThumbnail(
        {
          id: "a",
          kind: "VIDEO",
          fileName: "a.mp4",
          sourcePath: "relative.mp4",
          sizeBytes: 1,
          modifiedAt: "",
          addedAt: "",
          sourcePolicy: "READ_ONLY",
          metadataState: "READY",
          previewState: "READY",
          previewRange: { inMs: 0, outMs: 1000 },
        } as never,
        {
          id: "t",
          assetId: "a",
          sourceTimeMs: 0,
          sourceFileName: "a.mp4",
          reason: "test",
          layout: "LEFT_TEXT",
          colorNote: "",
          style: {
            text: "",
            textXPercent: 50,
            textYPercent: 50,
            fontSizePx: 40,
            textColor: "#fff",
            outlineWidthPx: 1,
            overlayOpacityPercent: 0,
          },
        },
        "C:\\tmp\\thumb.jpg",
        "jpg",
        "definitely-not-a-real-ffmpeg",
      ),
    ).rejects.toThrow(/來源路徑無效/);
  });

  it("falls back to white when textColor is not a plain hex color", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thumb-color-"));
    const asset = { kind: "IMAGE", sourcePath: path.join(dir, "a.png") } as never;
    const candidate = (textColor: string) =>
      ({
        sourceTimeMs: 0,
        style: {
          text: "hello",
          textXPercent: 50,
          textYPercent: 50,
          fontSizePx: 40,
          textColor,
          outlineWidthPx: 1,
          overlayOpacityPercent: 0,
        },
      }) as never;
    try {
      spawnedArgs.length = 0;
      const bad = "#FFFFFF,movie=x";
      await expect(renderThumbnail(asset, candidate(bad), path.join(dir, "o.jpg"), "jpg", "ffmpeg")).rejects.toThrow();
      await expect(
        renderThumbnail(asset, candidate("#12ab34"), path.join(dir, "o2.jpg"), "jpg", "ffmpeg"),
      ).rejects.toThrow();
      const vf = (args: string[]) => args[args.indexOf("-vf") + 1];
      expect(vf(spawnedArgs[0])).not.toContain("movie=x");
      expect(vf(spawnedArgs[0])).toContain("fontcolor=#FFFFFF:");
      expect(vf(spawnedArgs[1])).toContain("fontcolor=#12ab34:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("thumbnail output protection (R1-01) and temp cleanup (R1-17)", () => {
  async function setupDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thumb-protect-"));
    const source = path.join(dir, "photo.png");
    await writeFile(source, "original image");
    return { dir, source };
  }
  const imageAsset = (sourcePath: string) => ({ kind: "IMAGE", sourcePath }) as never;
  const withText = (text: string) =>
    ({
      sourceTimeMs: 0,
      style: { ...(cand as { style: object }).style, text },
    }) as never;

  it("R1-01: refuses to export over the selected source image and never runs ffmpeg", async () => {
    const { dir, source } = await setupDir();
    try {
      const before = sha256(await readFile(source));
      spawnedArgs.length = 0;
      ffmpegMode.mode = "ok";
      await expect(renderThumbnail(imageAsset(source), cand, source, "png", "ffmpeg")).rejects.toThrow(/同一檔案/);
      expect(sha256(await readFile(source))).toBe(before);
      expect(spawnedArgs).toHaveLength(0);
    } finally {
      ffmpegMode.mode = "fail";
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R1-01: refuses a hard-link alias of the source as output", async () => {
    const { dir, source } = await setupDir();
    try {
      const alias = path.join(dir, "alias.png");
      await link(source, alias);
      const before = sha256(await readFile(source));
      ffmpegMode.mode = "ok";
      await expect(renderThumbnail(imageAsset(source), cand, alias, "png", "ffmpeg")).rejects.toThrow(/硬連結/);
      expect(sha256(await readFile(source))).toBe(before);
    } finally {
      ffmpegMode.mode = "fail";
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R1-01: refuses an excluded project source passed as protected path", async () => {
    const { dir, source } = await setupDir();
    try {
      const excluded = path.join(dir, "excluded.png");
      await writeFile(excluded, "excluded image bytes");
      const before = sha256(await readFile(excluded));
      ffmpegMode.mode = "ok";
      await expect(
        renderThumbnail(imageAsset(source), cand, excluded, "png", "ffmpeg", {
          protectedPaths: [{ label: "專案素材「excluded.png」", path: excluded }],
        }),
      ).rejects.toThrow(/專案素材/);
      expect(sha256(await readFile(excluded))).toBe(before);
    } finally {
      ffmpegMode.mode = "fail";
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R1-17: leaves no partial or text file in the output folder when ffmpeg fails", async () => {
    const { dir, source } = await setupDir();
    try {
      ffmpegMode.mode = "fail";
      await expect(
        renderThumbnail(imageAsset(source), withText("hello"), path.join(dir, "out.png"), "png", "ffmpeg"),
      ).rejects.toThrow(/縮圖產出失敗/);
      expect((await readdir(dir)).sort()).toEqual(["photo.png"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R1-17: aborting a running thumbnail kills ffmpeg and removes only this job's temp files", async () => {
    const { dir, source } = await setupDir();
    try {
      ffmpegMode.mode = "hang";
      const controller = new AbortController();
      const before = spawnedArgs.length;
      const running = renderThumbnail(imageAsset(source), withText("hi"), path.join(dir, "out.png"), "png", "ffmpeg", {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(spawnedArgs.length).toBeGreaterThan(before));
      controller.abort();
      await expect(running).rejects.toThrow(/已取消/);
      expect((await readdir(dir)).sort()).toEqual(["photo.png"]);
    } finally {
      ffmpegMode.mode = "fail";
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("success publishes the thumbnail and leaves no temp files; the source is untouched", async () => {
    const { dir, source } = await setupDir();
    try {
      const before = sha256(await readFile(source));
      ffmpegMode.mode = "ok";
      const result = await renderThumbnail(imageAsset(source), cand, path.join(dir, "out.png"), "png", "ffmpeg");
      expect(result.sizeBytes).toBe(256);
      expect((await readdir(dir)).sort()).toEqual(["out.png", "photo.png"]);
      expect(sha256(await readFile(source))).toBe(before);
    } finally {
      ffmpegMode.mode = "fail";
      await rm(dir, { recursive: true, force: true });
    }
  });
});
