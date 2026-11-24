import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashPortableTree, preparePortableVersion } from "../src/main/services/portable-update-install";
import type { PortableManifest } from "../src/main/services/portable-update";

const manifest: PortableManifest = {
  schemaVersion: 1,
  version: "0.89.0",
  file: "scenerywalker-portable-win-x64.zip",
  bytes: 1,
  sha256: "0".repeat(64),
};

async function extractFixture(_archive: string, dest: string): Promise<void> {
  const directory = path.join(dest, "SceneryWalkerSourceOrganizer-win32-x64");
  await mkdir(path.join(directory, "resources"), { recursive: true });
  await writeFile(path.join(directory, "SceneryWalkerSourceOrganizer-v0.89.0.exe"), "fake exe");
  await writeFile(path.join(directory, "resources", "app.asar"), "fake asar");
}

describe("portable update preparation", () => {
  it("retains the old package, verifies a new isolated directory and detects tampering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portable-preparation-"));
    try {
      await writeFile(path.join(root, "old.exe"), "old");
      const smoke = vi.fn(async () => undefined);
      const next = await preparePortableVersion("fixture", manifest, root, { extract: extractFixture, smoke });
      expect(smoke).toHaveBeenCalledOnce();
      expect(await readdir(root)).toContain("old.exe");
      expect(await hashPortableTree(next.directory)).toBe(next.treeHash);
      await writeFile(next.executable, "modified");
      expect(await hashPortableTree(next.directory)).not.toBe(next.treeHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only the new staging directory when the isolated launch fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portable-preparation-"));
    try {
      await writeFile(path.join(root, "old.exe"), "old");
      await expect(
        preparePortableVersion("fixture", manifest, root, {
          extract: extractFixture,
          smoke: async () => {
            throw new Error("smoke failed");
          },
        }),
      ).rejects.toThrow("smoke failed");
      expect(await readdir(root)).toEqual(["old.exe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
