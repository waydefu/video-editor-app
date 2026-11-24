import { describe, expect, it } from "vitest";
import { RenderAdmission } from "../src/main/services/render-admission";

describe("RenderAdmission", () => {
  it("rejects a second job during asynchronous preflight and releases on success", async () => {
    const gate = new RenderAdmission();
    let finish!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(gate.busy).toBe(true);
    await expect(gate.run(async () => undefined)).rejects.toThrow();
    finish();
    await first;
    expect(gate.busy).toBe(false);
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });

  it("releases admission after preflight errors", async () => {
    const gate = new RenderAdmission();
    await expect(
      gate.run(async () => {
        throw new Error("preflight failure");
      }),
    ).rejects.toThrow("preflight failure");
    expect(gate.busy).toBe(false);
  });
});
