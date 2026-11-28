import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BgmService } from "../src/main/services/bgm-service";
import type { MediaProbe } from "../src/main/services/media-probe";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-epoch-"));
  roots.push(root);
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PR-A06 project generation context", () => {
  it("changes the generation when a project is created, opened, or saved as a new id", async () => {
    const { root, store } = await setup();
    const start = store.getProjectContext();
    expect(start.projectId).toBe(store.getProject().id);

    const created = await store.newProject();
    const afterNew = store.getProjectContext();
    expect(afterNew.projectId).toBe(created.project.id);
    expect(afterNew.generation).toBeGreaterThan(start.generation);
    expect(store.isCurrentProjectContext(start)).toBe(false);
    expect(store.isCurrentProjectContext(afterNew)).toBe(true);

    const saved = path.join(root, "saved.swproj");
    await store.saveProjectAs(saved, "Saved");
    const afterSave = store.getProjectContext();
    expect(afterSave.generation).toBeGreaterThan(afterNew.generation);

    await store.newProject();
    const beforeOpen = store.getProjectContext();
    await store.openProject(saved);
    const afterOpen = store.getProjectContext();
    expect(afterOpen.generation).toBeGreaterThan(beforeOpen.generation);
    expect(store.isCurrentProjectContext(beforeOpen)).toBe(false);
  });

  it("does not change the generation for ordinary edits", async () => {
    const { root, store } = await setup();
    const sourcePath = path.join(root, "photo.jpg");
    await writeFile(sourcePath, "photo");
    const before = store.getProjectContext();
    await store.setSortMode("FILE_NAME");
    expect(store.getProjectContext()).toEqual(before);
  });

  it("refuses a stale context inside the write queue and leaves the current project untouched", async () => {
    const { root, store } = await setup();
    const sourcePath = path.join(root, "clip.mp4");
    await writeFile(sourcePath, "fixture");
    const stale = store.getProjectContext();
    const next = await store.newProject();

    const asset = {
      id: "stale-asset",
      sourcePath,
      sourceIdentity: "stale-asset",
      fileName: "clip.mp4",
      extension: ".mp4",
      kind: "VIDEO",
      sizeBytes: 7,
      fileCreatedAt: new Date(0).toISOString(),
      fileModifiedAt: new Date(0).toISOString(),
      addedAt: new Date(0).toISOString(),
      addedOrder: 0,
      sourcePolicy: "READ_ONLY",
      previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
      previewCacheKey: "0".repeat(64),
      metadataState: "PENDING",
    } as const;
    await expect(store.addAssets([asset as never], stale)).rejects.toMatchObject({
      name: "StaleProjectContextError",
    });
    expect(store.getProject().id).toBe(next.project.id);
    expect(store.getProject().sources).toHaveLength(0);
  });
});

describe("PR-A06 cross-project commits (R1-04, R1-05)", () => {
  it("R1-04: an import that is still ADDING when New Project runs does not commit into the new project", async () => {
    const { root, store } = await setup();
    const file = path.join(root, "one.mp4");
    await writeFile(file, "original");
    const oldId = store.getProject().id;
    let creation: ReturnType<ProjectStore["newProject"]> | undefined;
    const source = new SourceService(store, {} as MediaProbe);
    const result = await source.importSelected([file], undefined, (progress) => {
      if (progress.phase === "ADDING" && progress.processed === 0) creation = store.newProject();
    });
    const next = await creation!;
    expect(next.project.id).not.toEqual(oldId);
    expect(store.getProject().id).toEqual(next.project.id);
    expect(store.getProject().sources).toHaveLength(0);
    expect(result.cancelled).toBe(true);
    expect(result.addedCount).toBe(0);
  });

  it("R1-05: a BGM probe that finishes after a project switch does not add the track to the new project", async () => {
    const { root, store } = await setup();
    const file = path.join(root, "music.mp3");
    await writeFile(file, "fake audio");
    let enter!: () => void;
    let complete!: (value: unknown) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const probe = {
      probe: () => {
        enter();
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    } as unknown as MediaProbe;
    const service = new BgmService(store, probe);
    const work = service.importSelected([file]);
    await entered;
    const created = await store.newProject();
    complete({ durationMs: 1000, audioCodec: "mp3" });
    const result = await work;
    expect(store.getProject().id).toBe(created.project.id);
    expect(store.getProject().bgmTracks).toHaveLength(0);
    expect(result.cancelled).toBe(true);
  });
});
