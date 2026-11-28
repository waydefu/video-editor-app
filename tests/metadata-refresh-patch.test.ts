import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MediaProbe } from "../src/main/services/media-probe";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-metadata-patch-"));
  roots.push(root);
  const store = new ProjectStore(path.join(root, "data"));
  await store.initialize();
  return { root, store };
}

/** A probe whose result the test resolves by hand, so user edits can land while it is running. */
function holdingProbe() {
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
  return { probe, entered, finish: (value: unknown) => complete(value) };
}

const probedInfo = { width: 100, height: 100, displayWidth: 100, displayHeight: 100, rotationDegrees: 0 };

// R1-10: the probe must patch only technical fields. The user's 6000 ms duration must survive the probe.
it("R1-10: a metadata probe does not revert a photo duration edited while it ran", async () => {
  const { root, store } = await setup();
  const file = path.join(root, "photo.jpg");
  await writeFile(file, "photo");
  const imported = await new SourceService(store, {} as MediaProbe).importSelected([file]);
  const id = imported.project.sources[0].id;
  const hold = holdingProbe();
  const pending = new SourceService(store, hold.probe).ensureMetadata(id);
  await hold.entered;
  await store.setImageDuration(id, 6000);
  hold.finish(probedInfo);
  const result = await pending;
  expect(store.getAsset(id)?.imageDurationMs).toBe(6000);
  expect(result.imageDurationMs).toBe(6000);
  expect(store.getAsset(id)?.metadataState).toBe("READY");
  expect(store.getAsset(id)?.mediaInfo).toMatchObject({ width: 100, height: 100 });
});

it("R1-10: other user settings changed during a probe (photo sound) are kept with the technical result", async () => {
  const { root, store } = await setup();
  const file = path.join(root, "photo.jpg");
  await writeFile(file, "photo");
  const imported = await new SourceService(store, {} as MediaProbe).importSelected([file]);
  const id = imported.project.sources[0].id;
  const hold = holdingProbe();
  const pending = new SourceService(store, hold.probe).ensureMetadata(id);
  await hold.entered;
  await store.setPhotoSoundEnabled(id, false);
  hold.finish(probedInfo);
  await pending;
  expect(store.getAsset(id)?.photoSoundEnabled).toBe(false);
  expect(store.getAsset(id)?.metadataState).toBe("READY");
});

it("drops a probe result that finishes after the project was replaced and commits nothing into the new project", async () => {
  const { root, store } = await setup();
  const file = path.join(root, "photo.jpg");
  await writeFile(file, "photo");
  const imported = await new SourceService(store, {} as MediaProbe).importSelected([file]);
  const id = imported.project.sources[0].id;
  const hold = holdingProbe();
  const pending = new SourceService(store, hold.probe).ensureMetadata(id);
  await hold.entered;
  await store.newProject();
  hold.finish(probedInfo);
  await expect(pending).rejects.toThrow();
  expect(store.getProject().sources).toHaveLength(0);
});
