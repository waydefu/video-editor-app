import { describe, expect, it } from "vitest";
import { IpcActivityGate } from "../src/main/services/ipc-activity-gate";

describe("IPC update admission", () => {
  it("blocks switching while an asynchronous operation is pending", async () => {
    const gate = new IpcActivityGate();
    let finish!: () => void;
    const pending = gate.run(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(() => gate.seal()).toThrow();
    finish();
    await pending;
    const release = gate.seal();
    await expect(gate.run(() => 1)).rejects.toThrow();
    release();
    await expect(gate.run(() => 1)).resolves.toBe(1);
  });
});
