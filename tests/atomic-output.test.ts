import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ failures: [] as string[] }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const code = renameControl.failures.shift();
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
      return actual.rename(from, to);
    }),
  };
});

import { finalizePartialOutput } from "../src/main/services/atomic-output";

const roots: string[] = [];
beforeEach(() => {
  renameControl.failures = [];
});
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup(existing?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atomic-output-"));
  roots.push(root);
  const partial = path.join(root, "out.partial.json");
  const output = path.join(root, "out.json");
  await writeFile(partial, "new");
  if (existing !== undefined) await writeFile(output, existing);
  return { root, partial, output };
}

describe("finalizePartialOutput", () => {
  it("overwrites an existing file without leaving replaced or partial files", async () => {
    const { root, partial, output } = await setup("old");
    await finalizePartialOutput(partial, output);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });

  it("retries transient EPERM errors and then succeeds", async () => {
    const { root, partial, output } = await setup("old");
    renameControl.failures = ["EPERM", "EPERM"];
    await finalizePartialOutput(partial, output);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });

  it("keeps the old file and rethrows when every retry fails", async () => {
    const { root, partial, output } = await setup("old");
    renameControl.failures = Array.from({ length: 10 }, () => "EBUSY");
    await expect(finalizePartialOutput(partial, output)).rejects.toMatchObject({ code: "EBUSY" });
    expect(await readFile(output, "utf8")).toBe("old");
    expect((await readdir(root)).sort()).toEqual(["out.json", "out.partial.json"]);
  });

  it("cleans the cross-volume partial when the final rename keeps failing", async () => {
    const { root, partial, output } = await setup("old");
    renameControl.failures = ["EXDEV", ...Array.from({ length: 10 }, () => "EPERM")];
    await expect(finalizePartialOutput(partial, output)).rejects.toMatchObject({ code: "EPERM" });
    expect(await readFile(output, "utf8")).toBe("old");
    expect((await readdir(root)).filter((name) => name.includes("cross-volume"))).toEqual([]);
  });

  it("publishes through the destination volume on EXDEV and removes the source", async () => {
    const { root, partial, output } = await setup("old");
    renameControl.failures = ["EXDEV"];
    await finalizePartialOutput(partial, output);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });
});
