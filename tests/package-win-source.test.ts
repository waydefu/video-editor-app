import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows packaging source reproducibility", () => {
  it("requires a checksum-verified explicit asset instead of machine-specific directories", async () => {
    const script = await readFile(path.join(process.cwd(), "scripts/package-win.mjs"), "utf8");
    expect(script).toContain("SCENERYWALKER_SHUTTER_MP3");
    expect(script).toContain("dunesShutterHash");
    expect(script).toContain("assets");
    expect(script).not.toContain("C:\\\\草漯");
    expect(script).not.toContain('path.join(\n    appRoot,\n    "release",');
  });
});
