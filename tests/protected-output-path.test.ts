import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOutputPathNotProtected, protectedProjectPaths } from "../src/main/services/protected-output-path";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "protected-output-"));
  roots.push(root);
  return root;
}

const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

describe("assertOutputPathNotProtected", () => {
  it("blocks an output path equal to a protected source and leaves its bytes unchanged", async () => {
    const root = await setup();
    const source = path.join(root, "clip.mp4");
    await writeFile(source, "original media");
    const before = await sha256(source);
    await expect(assertOutputPathNotProtected(source, [{ label: "測試素材", path: source }])).rejects.toThrow(
      /同一檔案/,
    );
    expect(await sha256(source)).toBe(before);
  });

  it("blocks a hard-link alias of a protected source", async () => {
    const root = await setup();
    const source = path.join(root, "clip.mp4");
    const alias = path.join(root, "alias.mp4");
    await writeFile(source, "original media");
    await link(source, alias);
    await expect(assertOutputPathNotProtected(alias, [{ label: "測試素材", path: source }])).rejects.toThrow(/硬連結/);
  });

  it("blocks a symlink alias of a protected source", async (ctx) => {
    const root = await setup();
    const source = path.join(root, "clip.mp4");
    const alias = path.join(root, "link.mp4");
    await writeFile(source, "original media");
    try {
      await symlink(source, alias, "file");
    } catch (error) {
      // Creating file symlinks needs Developer Mode or admin on Windows; report, don't fake it.
      if ((error as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
      throw error;
    }
    await expect(assertOutputPathNotProtected(alias, [{ label: "測試素材", path: source }])).rejects.toThrow(
      /同一檔案/,
    );
  });

  it("blocks a not-yet-existing output inside an aliased directory of a protected source", async () => {
    const root = await setup();
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias-dir");
    await mkdir(realDir);
    // Junctions need no special privilege on Windows; plain directory symlinks elsewhere.
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const source = path.join(realDir, "clip.mp4");
    await writeFile(source, "original media");
    await expect(
      assertOutputPathNotProtected(path.join(aliasDir, "clip.mp4"), [{ label: "測試素材", path: source }]),
    ).rejects.toThrow(/同一檔案/);
  });

  it.runIf(process.platform === "win32")("blocks a case-only difference on Windows", async () => {
    const root = await setup();
    const source = path.join(root, "Clip.mp4");
    await writeFile(source, "original media");
    await expect(
      assertOutputPathNotProtected(path.join(root, "clip.MP4"), [{ label: "測試素材", path: source }]),
    ).rejects.toThrow(/同一檔案/);
  });

  it("allows a different new file and a different existing file", async () => {
    const root = await setup();
    const source = path.join(root, "clip.mp4");
    const other = path.join(root, "other.mp4");
    await writeFile(source, "original media");
    await writeFile(other, "other");
    await expect(
      assertOutputPathNotProtected(path.join(root, "new-output.mp4"), [{ label: "測試素材", path: source }]),
    ).resolves.toBeUndefined();
    await expect(assertOutputPathNotProtected(other, [{ label: "測試素材", path: source }])).resolves.toBeUndefined();
  });

  it("protects a missing (offline) source by its canonical path without failing", async () => {
    const root = await setup();
    const missing = path.join(root, "offline.mp3");
    await expect(
      assertOutputPathNotProtected(path.join(root, "out.mp4"), [{ label: "配樂", path: missing }]),
    ).resolves.toBeUndefined();
    await expect(assertOutputPathNotProtected(missing, [{ label: "配樂", path: missing }])).rejects.toThrow();
  });
});

describe("protectedProjectPaths", () => {
  it("includes every project source (even excluded ones) and every BGM file", () => {
    const paths = protectedProjectPaths({
      sources: [
        { fileName: "used.mp4", sourcePath: "C:\\media\\used.mp4" },
        { fileName: "excluded.mp4", sourcePath: "C:\\media\\excluded.mp4" },
      ] as never,
      bgmTracks: [{ fileName: "song.mp3", sourcePath: "C:\\music\\song.mp3" }] as never,
    });
    expect(paths.map((item) => item.path)).toEqual([
      "C:\\media\\used.mp4",
      "C:\\media\\excluded.mp4",
      "C:\\music\\song.mp3",
    ]);
  });
});
