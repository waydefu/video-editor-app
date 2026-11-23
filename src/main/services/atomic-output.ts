import { randomUUID } from "node:crypto";
import { copyFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 75;

// On Windows, rename() replaces an existing destination in one step. Antivirus or
// indexers can briefly hold the file, so retry transient lock errors.
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_RENAME_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

export async function finalizePartialOutput(partialPath: string, outputPath: string): Promise<void> {
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
      await rm(partialPath, { force: true });
    }
  } catch (error) {
    await rm(crossVolumePartial, { force: true });
    throw error;
  }
}
