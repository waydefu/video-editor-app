import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
// Errors meaning "this filesystem cannot hard-link" (for example FAT or exFAT). These
// are not refusals: the no-replace publish falls back to an exclusive reservation.
const LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"]);
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

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

// On Windows, rename() replaces an existing destination in one step. Antivirus or
// indexers can briefly hold the file, so retry transient lock errors.
async function retryTransient(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = codeOf(error);
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
  const code = codeOf(error);
  if (code === "EEXIST") return new OutputAlreadyExistsError(outputPath, partialPath);
  const failure = new Error(
    `無法在不覆寫既有檔案的條件下發佈成品（${code ?? "未知錯誤"}）；成品暫存檔已保留於：${partialPath}。`,
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
    const code = codeOf(error);
    if (code === "EEXIST") throw new OutputAlreadyExistsError(outputPath, partialPath);
    // EXDEV: source on another volume. Unsupported link: FAT/exFAT. Both use the reservation path.
    if (code !== "EXDEV" && !(code && LINK_UNSUPPORTED_CODES.has(code)))
      throw noClobberFailure(error, partialPath, outputPath);
    await publishByReservation(partialPath, outputPath);
  }
  // Published. Removing the source name must not turn a finished output into a failure.
  await rm(partialPath, { force: true }).catch((error: unknown) => {
    console.warn("已完成成品寫入，但無法清理來源暫存檔。", error);
  });
}

/**
 * No-replace publish for filesystems without hard links. (1) An exclusive create
 * reserves the name; EEXIST means another owner, so refuse. (2) Rename the source
 * over our own empty placeholder, staging a copy on the destination volume on EXDEV.
 * (3) On failure remove only the placeholder we created, and only while it is still
 * empty. (4) Before each rename the placeholder must still be size 0, or we refuse.
 * The source partial is never removed here.
 */
async function publishByReservation(sourcePath: string, outputPath: string): Promise<void> {
  try {
    const handle = await open(outputPath, "wx");
    await handle.close();
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw new OutputAlreadyExistsError(outputPath, sourcePath);
    throw noClobberFailure(error, sourcePath, outputPath);
  }
  // From here the zero-byte placeholder is ours; it is the only thing we may remove.
  let staging: string | undefined;
  try {
    await assertPlaceholderStillEmpty(outputPath, sourcePath);
    try {
      await retryTransient(() => rename(sourcePath, outputPath));
    } catch (error) {
      if (codeOf(error) !== "EXDEV") throw error;
      const parsed = path.parse(outputPath);
      staging = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.cross-volume.partial${parsed.ext}`);
      await copyFile(sourcePath, staging, constants.COPYFILE_EXCL);
      await assertPlaceholderStillEmpty(outputPath, sourcePath);
      await retryTransient(() => rename(staging as string, outputPath));
      staging = undefined;
    }
  } catch (error) {
    if (staging) await rm(staging, { force: true }).catch(() => undefined);
    await removeOwnPlaceholder(outputPath);
    if (error instanceof OutputAlreadyExistsError) throw error;
    throw noClobberFailure(error, sourcePath, outputPath);
  }
}

async function assertPlaceholderStillEmpty(outputPath: string, partialPath: string): Promise<void> {
  const info = await stat(outputPath);
  if (!info.isFile() || info.size !== 0) throw new OutputAlreadyExistsError(outputPath, partialPath);
}

async function removeOwnPlaceholder(outputPath: string): Promise<void> {
  const info = await stat(outputPath).catch(() => undefined);
  // A non-empty file was written by someone else: keep it.
  if (info?.isFile() && info.size === 0) await rm(outputPath, { force: true }).catch(() => undefined);
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
