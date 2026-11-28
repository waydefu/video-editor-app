import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcatRenderService } from "../src/main/services/concat-render";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";
import { mainRenderSelections } from "../src/shared/editing-rules";

// Real FFmpeg is used only to create two tiny fixtures; the protection check throws before any encode.
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concat-output-protection-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

async function makeProject(name: string) {
  const dir = path.join(root, name);
  const store = new ProjectStore(path.join(dir, "app-data"));
  await store.initialize();
  const sources = new SourceService(store, new MediaProbe());
  const active = path.join(dir, "active.mp4");
  const excluded = path.join(dir, "excluded.mp4");
  for (const [file, color] of [
    [active, "red"],
    [excluded, "blue"],
  ] as const) {
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${color}:s=320x180:r=30`,
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      file,
    ]);
  }
  await sources.importSelected([active, excluded]);
  await Promise.all(store.getProject().sources.map((asset) => sources.ensureMetadata(asset.id)));
  const excludedAsset = store.getProject().sources.find((asset) => asset.sourcePath === excluded)!;
  await store.removeMainAsset(excludedAsset.id);
  const clipSelections = mainRenderSelections(store.getProject());
  const request = {
    outputToken: "test",
    orderedAssetIds: clipSelections.map((clip) => clip.assetId),
    clipSelections,
    transitionSeconds: 0.3,
    resolution: "360P",
    includeWatermark: false,
  } as const;
  return { dir, store, sources, active, excluded, request: request as never };
}

describe("concat output never targets a project-referenced file (R1-02)", () => {
  it("refuses an excluded project source as the output and leaves its bytes unchanged", async () => {
    const { store, sources, excluded, request } = await makeProject("excluded-target");
    const before = await sha256(excluded);
    await expect(new ConcatRenderService(store, sources).render(request, excluded)).rejects.toThrow(/同一檔案/);
    expect(await sha256(excluded)).toBe(before);
  }, 60_000);

  it("refuses a hard-link alias of an excluded project source", async () => {
    const { dir, store, sources, excluded, request } = await makeProject("excluded-alias");
    const alias = path.join(dir, "alias-of-excluded.mp4");
    await link(excluded, alias);
    const before = await sha256(excluded);
    await expect(new ConcatRenderService(store, sources).render(request, alias)).rejects.toThrow(/硬連結/);
    expect(await sha256(excluded)).toBe(before);
  }, 60_000);
});
