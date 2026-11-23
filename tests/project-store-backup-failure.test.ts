import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    copyFile: vi.fn(async (from: string, to: string) => {
      if (String(to).includes(".bak-v")) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      return actual.copyFile(from, to);
    }),
  };
});

import { ProjectStore } from "../src/main/services/project-store";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectStore migration backup failure", () => {
  it("still loads and migrates when the backup copy fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "source-app-backup-fail-"));
    roots.push(root);
    const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "legacy",
        name: "舊專案",
        sourcePolicy: "READ_ONLY",
        previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
        previewerVersion: "preview-v1",
        sortMode: "ADDED_ORDER",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sources: [],
      }),
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loaded = await new ProjectStore(root).initialize();
    expect(loaded).toMatchObject({ id: "legacy", schemaVersion: 21 });
    expect(JSON.parse(await readFile(manifestPath, "utf8")).schemaVersion).toBe(21);
    expect(warn).toHaveBeenCalled();
  });
});
