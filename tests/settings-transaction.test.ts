import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsTransaction } from "../src/main/services/settings-transaction";

describe("SettingsTransaction", () => {
  it("recovers both files after interruption between mirror writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "settings-transaction-"));
    const settings = path.join(root, "settings.json");
    const credentials = path.join(root, "credentials.json");
    const validate = (a: unknown, b: unknown) => typeof a === "object" && typeof b === "object";
    let failCredentials = true;
    const write = async (filePath: string, value: unknown) => {
      if (failCredentials && filePath === credentials) throw new Error("simulated ENOSPC");
      await writeFile(filePath, JSON.stringify(value));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeFile(settings, JSON.stringify({ version: "old" }));
      await writeFile(credentials, JSON.stringify({ encrypted: "old" }));
      const transaction = new SettingsTransaction(settings, credentials, validate, write);
      await transaction.commit({ version: "new" }, { encrypted: "new" });
      expect(JSON.parse(await readFile(transaction.journalPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
      failCredentials = false;
      await new SettingsTransaction(settings, credentials, validate, write).recover();
      expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ version: "new" });
      expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({ encrypted: "new" });
      await expect(readFile(transaction.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an invalid journal instead of overwriting it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "settings-transaction-"));
    try {
      const transaction = new SettingsTransaction(
        path.join(root, "settings.json"),
        path.join(root, "credentials.json"),
        () => false,
        async () => {
          throw new Error("unexpected write");
        },
      );
      await writeFile(transaction.journalPath, "broken");
      await expect(transaction.commit({}, {})).rejects.toThrow();
      expect(await readFile(transaction.journalPath, "utf8")).toBe("broken");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
