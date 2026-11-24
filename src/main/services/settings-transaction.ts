import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { finalizePartialOutput } from "./atomic-output";

type WriteJson = (filePath: string, value: unknown) => Promise<void>;

interface Snapshot {
  schemaVersion: 1;
  settings: unknown;
  credentials: unknown;
}

async function publishJournal(filePath: string, snapshot: Snapshot): Promise<void> {
  const partial = `${filePath}.${randomUUID()}.partial`;
  try {
    const file = await open(partial, "wx");
    try {
      await file.writeFile(JSON.stringify(snapshot), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await finalizePartialOutput(partial, filePath);
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

/** A pending journal is authoritative; malformed journals are never discarded. */
export class SettingsTransaction {
  readonly journalPath: string;

  constructor(
    private readonly settingsPath: string,
    private readonly credentialsPath: string,
    private readonly validate: (settings: unknown, credentials: unknown) => boolean,
    private readonly writeJson: WriteJson,
  ) {
    this.journalPath = `${credentialsPath}.transaction.json`;
  }

  async recover(): Promise<void> {
    let bytes: string;
    try {
      bytes = await readFile(this.journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const snapshot = JSON.parse(bytes) as Snapshot;
    if (snapshot?.schemaVersion !== 1 || !this.validate(snapshot.settings, snapshot.credentials))
      throw new Error("設定交易紀錄格式不相容；已保留原始資料。");
    await this.writeJson(this.settingsPath, snapshot.settings);
    await this.writeJson(this.credentialsPath, snapshot.credentials);
    await rm(this.journalPath);
  }

  async commit(settings: unknown, credentials: unknown): Promise<void> {
    // Never replace a previous committed journal until both mirrors recover.
    await this.recover();
    if (!this.validate(settings, credentials)) throw new Error("設定交易資料格式無效。");
    await publishJournal(this.journalPath, { schemaVersion: 1, settings, credentials });
    try {
      await this.recover();
    } catch (error) {
      // Commit already succeeded; the encrypted journal is the recovery source.
      console.warn("設定交易已提交，舊格式副本將於下次啟動或儲存時復原。", error);
    }
  }
}
