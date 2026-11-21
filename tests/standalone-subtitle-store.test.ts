import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  StandaloneSubtitleStore,
  authorizeSubtitleVideo,
  resolveSubtitleVideo,
  clearAuthorizedSubtitleVideos,
} from "../src/main/services/standalone-subtitle-store";
describe("standalone subtitle drafts", () => {
  it("revokes old source-media links after a project switch", () => {
    const url = authorizeSubtitleVideo("C:\\Videos\\old.mp4");
    const id = url.split("/").at(-1)!;
    expect(resolveSubtitleVideo(id)).toBeDefined();
    clearAuthorizedSubtitleVideos();
    expect(resolveSubtitleVideo(id)).toBeUndefined();
  });

  it("persists separately and leaves existing source and SRT untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-v087-"));
    try {
      const source = path.join(root, "video.mp4"),
        srt = path.join(root, "video.srt");
      await writeFile(source, "original-video");
      await writeFile(srt, "original-srt");
      const service = new StandaloneSubtitleStore(path.join(root, "workspaces"));
      const workspace = await service.create(source, "fingerprint", 10000, [
        { id: "cue", startMs: 1000, endMs: 5000, text: "林間步道", reviewStatus: "DRAFT" },
      ]);
      expect((await service.latest())?.cues).toHaveLength(1);
      expect(await readFile(workspace.draftPath, "utf8")).toContain("林間步道");
      expect(await readFile(source, "utf8")).toBe("original-video");
      expect(await readFile(srt, "utf8")).toBe("original-srt");
      await expect(service.save(workspace.id, [{ id: "cue", startMs: 9000, endMs: 11000, text: "x" }])).rejects.toThrow(
        /時間/,
      );
      await service.save(workspace.id, []);
      expect(await readFile(workspace.draftPath, "utf8")).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("supports legacy short or non-UUID project IDs without escaping the workspace root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-legacy-id-"));
    try {
      const service = new StandaloneSubtitleStore(path.join(root, "workspaces"));
      const workspace = await service.create(
        path.join(root, "shared.mp4"),
        "fingerprint",
        10000,
        [{ id: "cue", startMs: 100, endMs: 1000, text: "legacy project" }],
        undefined,
        "舊專案",
      );
      expect((await service.latest("舊專案"))?.id).toBe(workspace.id);
      expect(await service.latest("其他專案")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never authorizes another project's video when a pointer is corrupt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-forged-pointer-"));
    try {
      const workspaces = path.join(root, "workspaces");
      const store = new StandaloneSubtitleStore(workspaces);
      const foreignVideo = path.join(root, "foreign.mp4");
      await store.create(
        path.join(root, "local.mp4"),
        "fingerprint-a",
        1000,
        [{ id: "a", startMs: 0, endMs: 500, text: "A" }],
        undefined,
        "project-a",
      );
      const foreign = await store.create(
        foreignVideo,
        "fingerprint-b",
        1000,
        [{ id: "b", startMs: 0, endMs: 500, text: "B" }],
        undefined,
        "project-b",
      );
      const key = createHash("sha256").update("project-a").digest("hex");
      await writeFile(path.join(workspaces, "latest-by-project", `${key}.json`), JSON.stringify({ id: foreign.id }));
      clearAuthorizedSubtitleVideos();
      expect(await store.latest("project-a")).toBeNull();
      const foreignVideoId = createHash("sha256").update(path.resolve(foreignVideo)).digest("hex");
      expect(resolveSubtitleVideo(foreignVideoId)).toBeUndefined();
      expect((await store.latest("project-b"))?.id).toBe(foreign.id);
      expect(resolveSubtitleVideo(foreignVideoId)).toBe(path.resolve(foreignVideo));
    } finally {
      clearAuthorizedSubtitleVideos();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps per-project drafts isolated and preserves older same-video revisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-scope-"));
    try {
      const service = new StandaloneSubtitleStore(path.join(root, "workspaces"));
      const source = path.join(root, "shared.mp4");
      const first = await service.create(
        source,
        "fingerprint",
        10000,
        [{ id: "a", startMs: 100, endMs: 1000, text: "A original" }],
        undefined,
        "project-aaaaaaaa",
      );
      const other = await service.create(
        source,
        "fingerprint",
        10000,
        [{ id: "b", startMs: 100, endMs: 1000, text: "B" }],
        undefined,
        "project-bbbbbbbb",
      );
      const second = await service.create(
        source,
        "fingerprint",
        10000,
        [{ id: "c", startMs: 100, endMs: 1000, text: "A again" }],
        undefined,
        "project-aaaaaaaa",
      );
      expect(new Set([first.id, other.id, second.id]).size).toBe(3);
      expect((await service.latest("project-aaaaaaaa"))?.id).toBe(second.id);
      expect((await service.latest("project-bbbbbbbb"))?.id).toBe(other.id);
      expect(await service.latest("project-cccccccc")).toBeNull();
      expect((await service.get(first.id)).cues[0].text).toBe("A original");
      expect((await service.get(other.id)).ownerProjectId).toBe("project-bbbbbbbb");
      expect(await readFile(first.draftPath, "utf8")).toContain("A original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
