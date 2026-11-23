import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron IPC contract surface", () => {
  it("keeps all exposed preload invoke/send channels backed by main-process handlers", async () => {
    const root = process.cwd();
    const [ipc, boot, preload] = await Promise.all([
      readFile(path.join(root, "src/main/ipc.ts"), "utf8"),
      readFile(path.join(root, "src/main/main.ts"), "utf8"),
      readFile(path.join(root, "src/main/preload.ts"), "utf8"),
    ]);
    const mainHandlers = new Set(
      [...(ipc + boot).matchAll(/ipcMain\.(?:handle|on)\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
    );
    const exposedChannels = new Set(
      [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
    );
    expect(mainHandlers.size).toBeGreaterThan(100);
    expect(exposedChannels.size).toBeGreaterThan(100);
    expect([...exposedChannels].filter((channel) => !mainHandlers.has(channel)).sort()).toEqual([]);
  });
});
