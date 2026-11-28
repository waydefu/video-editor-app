import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, rename, rm } from "node:fs/promises";
import path from "node:path";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 75;

export interface FinalizeOptions {
  /**
   * Default true keeps the historical replace semantics for internal files.
   * Final render outputs pass false: an existing or newly appearing file at the
   * destination is never replaced, and the partial is kept for recovery.
   */
  allowOverwrite?: boolean;
}

/** Raised when a no-clobber publish finds an existing file. The partial is kept. */
export class OutputAlreadyExistsError extends Error {
  readonly code = "EEXIST";
  constructor(
    readonly outputPath: string,
    readonly partialPath: string,
  ) {
    super(
      `輸出檔案已存在（或在產出過程中被其他程式建立），為避免覆寫已停止，原檔未被改動。成品暫存檔已保留於：${partialPath}。請重新選擇輸出檔名後再試。`,
    );
    this.name = "OutputAlreadyExistsError";
  }
}

// On Windows, rename() replaces an existing destination in one step. Antivirus or
// indexers can briefly hold the file, so retry transient lock errors.
async function retryTransient(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_RENAME_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

function renameReplacing(from: string, to: string): Promise<void> {
  return retryTransient(() => rename(from, to));
}

// link() fails with EEXIST when the destination exists, on the same volume, so the
// check and the publish are one filesystem operation (no stat-then-rename race).
function linkWithoutReplacing(from: string, to: string): Promise<void> {
  return retryTransient(() => link(from, to));
}

function noClobberFailure(error: unknown, partialPath: string, outputPath: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return new OutputAlreadyExistsError(outputPath, partialPath);
  const failure = new Error(
    `無法在不覆寫既有檔案的條件下發佈成品（${code ?? "未知錯誤"}）。此磁碟可能不支援硬連結；成品暫存檔已保留於：${partialPath}。`,
    { cause: error },
  );
  (failure as Error & { code?: string }).code = code;
  return failure;
}

export async function finalizePartialOutput(
  partialPath: string,
  outputPath: string,
  options: FinalizeOptions = {},
): Promise<void> {
  if (options.allowOverwrite === false) return publishWithoutReplacing(partialPath, outputPath);
  return publishReplacing(partialPath, outputPath);
}

async function publishWithoutReplacing(partialPath: string, outputPath: string): Promise<void> {
  try {
    await linkWithoutReplacing(partialPath, outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw noClobberFailure(error, partialPath, outputPath);
    // Cross-volume: stage a copy on the destination volume, then no-replace link it in.
    const parsed = path.parse(outputPath);
    const crossVolumePartial = path.join(
      parsed.dir,
      `.${parsed.name}.${randomUUID()}.cross-volume.partial${parsed.ext}`,
    );
    try {
      await copyFile(partialPath, crossVolumePartial, constants.COPYFILE_EXCL);
      await linkWithoutReplacing(crossVolumePartial, outputPath);
    } catch (innerError) {
      await rm(crossVolumePartial, { force: true }).catch(() => undefined);
      throw noClobberFailure(innerError, partialPath, outputPath);
    }
    await rm(crossVolumePartial, { force: true }).catch(() => undefined);
  }
  // Published. Removing the source name must not turn a finished output into a failure.
  await rm(partialPath, { force: true }).catch((error: unknown) => {
    console.warn("已完成成品寫入，但無法清理來源暫存檔。", error);
  });
}

async function publishReplacing(partialPath: string, outputPath: string): Promise<void> {
  const parsed = path.parse(outputPath);
  const crossVolumePartial = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.cross-volume.partial${parsed.ext}`);
  try {
    try {
      await renameReplacing(partialPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Publish through a destination-volume partial so Final Output remains
      // atomic even when its audio mux temporary was scheduled elsewhere.
      await copyFile(partialPath, crossVolumePartial);
      await renameReplacing(crossVolumePartial, outputPath);
      // Publishing already succeeded; a locked TEMP must not report render failure.
      await rm(partialPath, { force: true }).catch((error: unknown) => {
        console.warn("已完成成品寫入，但無法清理來源暫存檔。", error);
      });
    }
  } catch (error) {
    await rm(crossVolumePartial, { force: true }).catch(() => undefined);
    throw error;
  }
}
