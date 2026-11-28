import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectManifest } from "../../shared/domain";

export interface ProtectedPathEntry {
  /** Traditional Chinese label used only in the user-facing error message. */
  label: string;
  path: string;
}

interface LocationIdentity {
  /** Canonical path (realpath for existing entries, otherwise canonical parent + name). */
  key: string;
  dev?: bigint;
  ino?: bigint;
}

function comparableKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function identify(target: string): Promise<LocationIdentity> {
  const absolute = path.resolve(target);
  try {
    const real = await realpath(absolute);
    const info = await stat(real, { bigint: true });
    return { key: real, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (!isMissing(error)) return { key: absolute };
  }
  // The output usually does not exist yet. Canonicalize the nearest existing
  // ancestor so that a case or alias difference in a parent folder is still caught.
  const parent = path.dirname(absolute);
  if (parent === absolute) return { key: absolute };
  const canonicalParent = await identify(parent);
  return { key: path.join(canonicalParent.key, path.basename(absolute)) };
}

function isSameLocation(left: LocationIdentity, right: LocationIdentity): boolean {
  // File identity catches hard links and junction/symlink aliases on NTFS and POSIX.
  if (
    left.dev !== undefined &&
    left.ino !== undefined &&
    right.dev !== undefined &&
    right.ino !== undefined &&
    left.ino !== BigInt(0) &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
    return true;
  return comparableKey(left.key) === comparableKey(right.key);
}

/**
 * Throws a Traditional Chinese error when outputPath is, or resolves to the same
 * file as, any protected path. Only compares; never copies, moves or writes.
 */
export async function assertOutputPathNotProtected(
  outputPath: string,
  protectedPaths: readonly ProtectedPathEntry[],
): Promise<void> {
  const output = await identify(outputPath);
  for (const entry of protectedPaths) {
    if (!entry.path) continue;
    const protectedId = await identify(entry.path);
    if (isSameLocation(output, protectedId)) {
      throw new Error(
        `輸出路徑與${entry.label}為同一檔案（或其別名、硬連結），已阻擋輸出以保護原始素材；來源檔未被修改。請選擇其他檔名或位置。`,
      );
    }
  }
}

/** Every file the project references: source media (used or excluded) and background music. */
export function protectedProjectPaths(project: Pick<ProjectManifest, "sources" | "bgmTracks">): ProtectedPathEntry[] {
  return [
    ...project.sources.map((asset) => ({ label: `專案素材「${asset.fileName}」`, path: asset.sourcePath })),
    ...project.bgmTracks.map((track) => ({ label: `配樂「${track.fileName}」`, path: track.sourcePath ?? "" })),
  ];
}
