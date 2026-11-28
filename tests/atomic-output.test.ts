import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ failures: [] as string[], lockedSource: "" }));
const linkControl = vi.hoisted(() => ({ failures: [] as string[] }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rm: vi.fn(async (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (target === renameControl.lockedSource) throw Object.assign(new Error("locked TEMP"), { code: "EBUSY" });
      return actual.rm(target, options);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const code = renameControl.failures.shift();
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
      return actual.rename(from, to);
    }),
    link: vi.fn(async (from: string, to: string) => {
      const code = linkControl.failures.shift();
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
      return actual.link(from, to);
    }),
  };
});

import { finalizePartialOutput, OutputAlreadyExistsError } from "../src/main/services/atomic-output";

const roots: string[] = [];
beforeEach(() => {
  renameControl.failures = [];
  renameControl.lockedSource = "";
  linkControl.failures = [];
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

  it("does not report failure after cross-volume publication when source cleanup fails", async () => {
    const { partial, output } = await setup("old");
    renameControl.failures = ["EXDEV"];
    renameControl.lockedSource = partial;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(finalizePartialOutput(partial, output)).resolves.toBeUndefined();
      expect(await readFile(output, "utf8")).toBe("new");
      expect(await readFile(partial, "utf8")).toBe("new");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      renameControl.lockedSource = "";
    }
  });
});

describe("finalizePartialOutput with allowOverwrite: false (R2-07 no-clobber commit)", () => {
  const noClobber = { allowOverwrite: false } as const;

  it("publishes a new output and removes the partial", async () => {
    const { root, partial, output } = await setup();
    await finalizePartialOutput(partial, output, noClobber);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });

  it("never replaces a file that appears at the destination, and keeps the partial for recovery", async () => {
    const { root, partial, output } = await setup();
    // Another writer created the destination after the render started.
    await writeFile(output, "other writer's file");
    await expect(finalizePartialOutput(partial, output, noClobber)).rejects.toBeInstanceOf(OutputAlreadyExistsError);
    expect(await readFile(output, "utf8")).toBe("other writer's file");
    expect((await readdir(root)).sort()).toEqual(["out.json", "out.partial.json"]);
    expect(await readFile(partial, "utf8")).toBe("new");
  });

  it("refuses an existing output with a clear message and keeps its bytes", async () => {
    const { partial, output } = await setup("old");
    await expect(finalizePartialOutput(partial, output, noClobber)).rejects.toThrow(/已存在/);
    expect(await readFile(output, "utf8")).toBe("old");
  });

  it("publishes through the destination volume on EXDEV without replacing anything", async () => {
    const { root, partial, output } = await setup();
    linkControl.failures = ["EXDEV"];
    await finalizePartialOutput(partial, output, noClobber);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });

  it("on EXDEV keeps an existing destination and removes only its own staging file", async () => {
    const { root, partial, output } = await setup("old");
    linkControl.failures = ["EXDEV"];
    await expect(finalizePartialOutput(partial, output, noClobber)).rejects.toBeInstanceOf(OutputAlreadyExistsError);
    expect(await readFile(output, "utf8")).toBe("old");
    expect((await readdir(root)).sort()).toEqual(["out.json", "out.partial.json"]);
  });

  it("fails clearly and keeps the partial when the volume cannot hard-link", async () => {
    const { root, partial, output } = await setup();
    linkControl.failures = Array.from({ length: 10 }, () => "EPERM");
    await expect(finalizePartialOutput(partial, output, noClobber)).rejects.toThrow(/無法在不覆寫/);
    expect((await readdir(root)).sort()).toEqual(["out.partial.json"]);
  });

  it("the default (no options) still replaces, for internal files", async () => {
    const { root, partial, output } = await setup("old");
    await finalizePartialOutput(partial, output);
    expect(await readFile(output, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["out.json"]);
  });
});
