import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderThumbnail } from "../src/main/services/thumbnail-render";

const spawnedArgs = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: string[]) => {
    spawnedArgs.push(args);
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    setImmediate(() => child.emit("close", 1));
    return child;
  },
}));

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
