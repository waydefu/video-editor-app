import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcatRenderService } from "../src/main/services/concat-render";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";
import { mainRenderSelections } from "../src/shared/editing-rules";

// Real FFmpeg renders a short clip; the final commit is what is under test.
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concat-no-clobber-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setupRender(name: string) {
  const dir = path.join(root, name);
  const store = new ProjectStore(path.join(dir, "app-data"));
  await store.initialize();
  const sources = new SourceService(store, new MediaProbe());
  const active = path.join(dir, "first.mp4");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=30",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    active,
  ]);
  await sources.importSelected([active]);
  await sources.ensureMetadata(store.getProject().sources[0].id);
  const clipSelections = mainRenderSelections(store.getProject());
  const request = {
    outputToken: "test",
    orderedAssetIds: clipSelections.map((clip) => clip.assetId),
    clipSelections,
    transitionSeconds: 0.3,
    resolution: "360P",
    includeWatermark: false,
  } as never;
  return { dir, store, sources, request };
}

describe("concat final commit is no-clobber (R2-07)", () => {
  it("an output created by another writer during FINALIZING is kept, and the render reports failure", async () => {
    const { dir, store, sources, request } = await setupRender("external-writer");
    const output = path.join(dir, "new-output.mp4");
    let inserted = false;
    const render = new ConcatRenderService(store, sources).render(request, output, undefined, (progress) => {
      // Synchronous callback right before finalization: simulate another process creating the file.
      if (progress.phase === "FINALIZING" && !inserted) {
        inserted = true;
        writeFileSync(output, "other writer's file", { flag: "wx" });
      }
    });
    await expect(render).rejects.toThrow(/已存在/);
    expect(inserted).toBe(true);
    expect((await readFile(output)).toString()).toBe("other writer's file");
  }, 60_000);

  it("an explicitly confirmed overwrite of an ordinary old output still replaces it", async () => {
    const { dir, store, sources, request } = await setupRender("confirmed-overwrite");
    const output = path.join(dir, "old-output.mp4");
    await writeFile(output, "old render");
    const result = await new ConcatRenderService(store, sources).render(request, output, undefined, () => undefined, {
      allowOverwrite: true,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect((await readFile(output)).toString()).not.toBe("old render");
  }, 60_000);
});
