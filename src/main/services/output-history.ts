import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type {
  ConcatRenderResult,
  PreviewOutputHistorySnapshot,
  PreviewOutputIdentityState,
  PreviewOutputImportResult,
  PreviewOutputPurpose,
  PreviewOutputRecord,
  PreviewResolution,
  RenderVideoCodec,
} from "../../shared/domain";
import { MediaProbe } from "./media-probe";
import { OUTPUT_RESOLUTIONS, outputDimensions } from "../../shared/render-profile";

/**
 * File identity recorded at registration. Size and mtime are checked on every listing;
 * the fingerprint (size + first and last 4 MiB) is checked only on get/upload so that
 * listing a library of multi-GB videos never hashes whole files.
 */
interface StoredIdentity {
  sizeBytes: number;
  mtimeMs: number;
  fingerprint: string;
}
interface StoredOutput extends Omit<PreviewOutputRecord, "exists" | "identityState"> {
  identity?: StoredIdentity;
}
interface StoredHistory {
  schemaVersion: 1;
  outputs: StoredOutput[];
}

const IDENTITY_EDGE_BYTES = 4 * 1024 * 1024;
const CHANGED_MESSAGE =
  "此預覽檔已與登錄時不同（大小、修改時間或內容有變），可能已被替換；為避免誤傳，已停止直接上傳。請先從清單移除此紀錄，再用「加入以前的 MP4」重新選擇此檔以確認。";
const UNVERIFIED_MESSAGE =
  "此紀錄是舊版 App 建立的，沒有檔案身分資料，尚未確認可安全上傳。請先從清單移除此紀錄，再用「加入以前的 MP4」重新選擇此檔以確認。";

async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("讀取預覽檔指紋時檔案長度改變");
  return buffer;
}

async function fingerprintFile(filePath: string, sizeBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const hash = createHash("sha256");
    hash.update(`head-tail-sha256-v1:${sizeBytes}:`);
    const headLength = Math.min(sizeBytes, IDENTITY_EDGE_BYTES);
    hash.update(await readRange(handle, 0, headLength));
    const tailStart = Math.max(0, sizeBytes - IDENTITY_EDGE_BYTES);
    hash.update(await readRange(handle, tailStart, sizeBytes - tailStart));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function captureIdentity(filePath: string): Promise<StoredIdentity | undefined> {
  try {
    const file = await stat(filePath);
    if (!file.isFile() || file.size < 1) return undefined;
    return {
      sizeBytes: file.size,
      mtimeMs: file.mtimeMs,
      fingerprint: await fingerprintFile(filePath, file.size),
    };
  } catch {
    // Without evidence the entry is shown as UNVERIFIED rather than trusted.
    return undefined;
  }
}

function statMatchesIdentity(identity: StoredIdentity, file: Stats): boolean {
  return file.size === identity.sizeBytes && file.mtimeMs === identity.mtimeMs;
}

function identityStateFromStat(item: StoredOutput, file: Stats): PreviewOutputIdentityState {
  if (!item.identity) return "UNVERIFIED";
  return statMatchesIdentity(item.identity, file) ? "VERIFIED" : "CHANGED";
}

function publicFields(item: StoredOutput): Omit<PreviewOutputRecord, "exists" | "identityState"> {
  const record: StoredOutput = structuredClone(item);
  delete record.identity;
  return record;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function validPurpose(value: unknown): value is PreviewOutputPurpose {
  return value === "CONCAT" || value === "INTRO" || value === "CLIP" || value === "SHORTS" || value === "UNKNOWN";
}

function validResolution(value: unknown): value is PreviewResolution {
  return (
    value === "360P" || value === "480P" || value === "720P" || value === "1080P" || value === "1440P" || value === "4K"
  );
}

function validVideoCodec(value: unknown): value is RenderVideoCodec {
  return (
    value === "H264_NVENC" ||
    value === "H265_NVENC" ||
    value === "H265_QSV" ||
    value === "H265" ||
    value === "H264_QSV" ||
    value === "H264"
  );
}

function sanitizeIdentity(value: unknown): StoredIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<StoredIdentity>;
  if (!Number.isFinite(item.sizeBytes) || Number(item.sizeBytes) < 0) return undefined;
  if (!Number.isFinite(item.mtimeMs)) return undefined;
  if (typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)) return undefined;
  return { sizeBytes: Number(item.sizeBytes), mtimeMs: Number(item.mtimeMs), fingerprint: item.fingerprint };
}

function sanitizeRecord(value: unknown): StoredOutput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<StoredOutput>;
  if (typeof item.jobId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(item.jobId)) return undefined;
  if (
    typeof item.outputPath !== "string" ||
    !path.isAbsolute(item.outputPath) ||
    path.extname(item.outputPath).toLowerCase() !== ".mp4"
  )
    return undefined;
  if (!validPurpose(item.purpose) || (item.origin !== "APP_RENDERED" && item.origin !== "IMPORTED_EXISTING"))
    return undefined;
  if (typeof item.createdAt !== "string" || Number.isNaN(new Date(item.createdAt).valueOf())) return undefined;
  if (!Number.isFinite(item.sizeBytes) || Number(item.sizeBytes) < 0) return undefined;
  return {
    jobId: item.jobId,
    outputPath: path.resolve(item.outputPath),
    fileName: path.basename(item.outputPath),
    purpose: item.purpose,
    origin: item.origin,
    createdAt: item.createdAt,
    sizeBytes: Math.round(Number(item.sizeBytes)),
    durationMs:
      Number.isFinite(item.durationMs) && Number(item.durationMs) >= 0
        ? Math.round(Number(item.durationMs))
        : undefined,
    resolution: validResolution(item.resolution) ? item.resolution : undefined,
    videoCodec: validVideoCodec(item.videoCodec) ? item.videoCodec : undefined,
    cancelled: item.cancelled === true,
    includedIntroSegmentCount:
      Number.isInteger(item.includedIntroSegmentCount) && Number(item.includedIntroSegmentCount) >= 0
        ? Number(item.includedIntroSegmentCount)
        : undefined,
    projectName:
      typeof item.projectName === "string" && item.projectName.trim()
        ? item.projectName.trim().slice(0, 160)
        : undefined,
    projectId:
      typeof item.projectId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(item.projectId) ? item.projectId : undefined,
    successful: typeof item.successful === "boolean" ? item.successful : undefined,
    aspectRatio:
      item.aspectRatio === "PORTRAIT_9_16" || item.aspectRatio === "LANDSCAPE_16_9" ? item.aspectRatio : undefined,
    attemptElapsedMs:
      Number.isFinite(item.attemptElapsedMs) && Number(item.attemptElapsedMs) >= 0
        ? Math.round(Number(item.attemptElapsedMs))
        : undefined,
    cumulativeElapsedMs:
      Number.isFinite(item.cumulativeElapsedMs) && Number(item.cumulativeElapsedMs) >= 0
        ? Math.round(Number(item.cumulativeElapsedMs))
        : undefined,
    identity: sanitizeIdentity(item.identity),
  };
}

function isHistory(value: unknown): value is StoredHistory {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<StoredHistory>).schemaVersion === 1 &&
    Array.isArray((value as Partial<StoredHistory>).outputs),
  );
}

export class OutputHistoryStore {
  readonly historyPath: string;
  private history: StoredHistory = { schemaVersion: 1, outputs: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataRoot: string,
    private readonly probe = new MediaProbe(),
  ) {
    this.historyPath = path.join(dataRoot, "settings", "preview-output-history.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.historyPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.historyPath, "utf8"));
      if (!isHistory(parsed)) throw new Error("預覽成品紀錄格式不相容");
      const seen = new Set<string>();
      this.history.outputs = parsed.outputs.map(sanitizeRecord).filter((item): item is StoredOutput => {
        if (!item) return false;
        const key = canonicalPath(item.outputPath);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Never overwrite an unreadable or corrupt index without first preserving
        // its original bytes. A failed backup must surface instead of losing history.
        const backupPath = `${this.historyPath}.invalid-${Date.now()}-${randomUUID()}`;
        await rename(this.historyPath, backupPath);
      }
      const empty: StoredHistory = { schemaVersion: 1, outputs: [] };
      await this.saveNow(empty);
      this.history = empty;
    }
  }

  async registerRender(
    result: ConcatRenderResult,
    projectName?: string,
    projectId?: string,
  ): Promise<PreviewOutputRecord> {
    const record: StoredOutput = {
      jobId: result.jobId,
      outputPath: path.resolve(result.outputPath),
      fileName: path.basename(result.outputPath),
      purpose: result.purpose,
      origin: "APP_RENDERED",
      createdAt: new Date().toISOString(),
      sizeBytes: result.sizeBytes,
      durationMs: result.expectedDurationMs,
      resolution: result.resolution,
      videoCodec: result.videoCodec,
      cancelled: result.cancelled,
      includedIntroSegmentCount: result.includedIntroSegmentCount,
      projectName,
      projectId: typeof projectId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(projectId) ? projectId : undefined,
      successful: result.cancelled !== true && result.sizeBytes > 0,
      aspectRatio: result.aspectRatio,
      attemptElapsedMs: result.attemptElapsedMs,
      cumulativeElapsedMs: result.cumulativeElapsedMs,
      identity: await captureIdentity(path.resolve(result.outputPath)),
    };
    await this.mutate((outputs) => {
      const key = canonicalPath(record.outputPath);
      return [
        record,
        ...outputs.filter((item) => item.jobId !== record.jobId && canonicalPath(item.outputPath) !== key),
      ];
    });
    return { ...publicFields(record), exists: true, identityState: record.identity ? "VERIFIED" : "UNVERIFIED" };
  }

  async importExisting(filePaths: string[]): Promise<PreviewOutputImportResult> {
    let addedCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const additions: StoredOutput[] = [];
    const known = new Set(this.history.outputs.map((item) => canonicalPath(item.outputPath)));
    for (const source of filePaths) {
      const resolved = path.resolve(source);
      const key = canonicalPath(resolved);
      if (known.has(key)) {
        duplicateCount += 1;
        continue;
      }
      try {
        if (path.extname(resolved).toLowerCase() !== ".mp4") throw new Error("只支援 MP4 預覽檔");
        const file = await stat(resolved);
        if (!file.isFile() || file.size < 1) throw new Error("檔案不存在或為空");
        const media = await this.probe.probe(resolved);
        if (!media.videoCodec) throw new Error("檔案沒有可辨識的影片軌");
        const displayWidth = media.displayWidth ?? media.width;
        const displayHeight = media.displayHeight ?? media.height;
        const portrait = Boolean(displayWidth && displayHeight && displayHeight > displayWidth);
        const resolution = OUTPUT_RESOLUTIONS.find((candidate) => {
          const dimensions = outputDimensions(candidate, portrait);
          return displayWidth === dimensions.width && displayHeight === dimensions.height;
        });
        const videoCodec =
          media.videoCodec?.toLowerCase() === "hevc" || media.videoCodec?.toLowerCase() === "h265"
            ? "H265"
            : media.videoCodec?.toLowerCase() === "h264"
              ? "H264"
              : undefined;
        additions.push({
          jobId: randomUUID(),
          identity: await captureIdentity(resolved),
          outputPath: resolved,
          fileName: path.basename(resolved),
          purpose: "UNKNOWN",
          origin: "IMPORTED_EXISTING",
          createdAt: file.birthtime.toISOString(),
          sizeBytes: file.size,
          durationMs: media.durationMs,
          resolution,
          videoCodec,
          aspectRatio: portrait ? "PORTRAIT_9_16" : "LANDSCAPE_16_9",
          successful: true,
        });
        known.add(key);
        addedCount += 1;
      } catch (error) {
        errors.push(`${path.basename(resolved)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (additions.length) {
      await this.mutate((outputs) => {
        // Media probing happens outside the write queue; recheck at commit time.
        const committed = new Set(outputs.map((item) => canonicalPath(item.outputPath)));
        const unique = additions.filter((item) => {
          const key = canonicalPath(item.outputPath);
          if (committed.has(key)) {
            addedCount -= 1;
            duplicateCount += 1;
            return false;
          }
          committed.add(key);
          return true;
        });
        return [...unique.reverse(), ...outputs];
      });
    }
    return { cancelled: false, addedCount, duplicateCount, errors, history: await this.snapshot() };
  }

  async snapshot(): Promise<PreviewOutputHistorySnapshot> {
    const outputs = await Promise.all(
      this.history.outputs.map(async (item): Promise<PreviewOutputRecord> => {
        const file = await stat(item.outputPath).catch(() => undefined);
        const exists = Boolean(file?.isFile() && file.size > 0);
        const identityState: PreviewOutputIdentityState =
          exists && file ? identityStateFromStat(item, file) : "MISSING";
        return {
          ...publicFields(item),
          exists,
          sizeBytes: file?.isFile() ? file.size : item.sizeBytes,
          identityState,
          successful: identityState === "CHANGED" ? false : item.successful,
        };
      }),
    );
    return { schemaVersion: 1, outputs };
  }

  /**
   * Opens the record for viewing or playing. A replaced file is reported as CHANGED instead of
   * inheriting the original project, duration and completion marker.
   */
  async get(jobId: string): Promise<PreviewOutputRecord> {
    if (typeof jobId !== "string") throw new Error("預覽成品 ID 無效。");
    const record = this.history.outputs.find((item) => item.jobId === jobId);
    if (!record) throw new Error("找不到這筆預覽成品紀錄。");
    const file = await stat(record.outputPath).catch(() => undefined);
    if (!file?.isFile() || file.size < 1) throw new Error("預覽成品已移動、刪除或離線；可保留紀錄供日後核對。");
    const identityState = await this.currentIdentityState(record, file);
    return {
      ...publicFields(record),
      exists: true,
      sizeBytes: file.size,
      identityState,
      successful: identityState === "CHANGED" ? false : record.successful,
    };
  }

  /** Lookup for upload and Chrome handoff: only a fully verified output may be sent. */
  async getForUpload(jobId: string): Promise<PreviewOutputRecord> {
    const output = await this.get(jobId);
    if (output.identityState === "VERIFIED") return output;
    throw new Error(output.identityState === "CHANGED" ? CHANGED_MESSAGE : UNVERIFIED_MESSAGE);
  }

  private async currentIdentityState(item: StoredOutput, file: Stats): Promise<PreviewOutputIdentityState> {
    if (!item.identity) return "UNVERIFIED";
    if (!statMatchesIdentity(item.identity, file)) return "CHANGED";
    const fingerprint = await fingerprintFile(item.outputPath, file.size).catch(() => undefined);
    return fingerprint === item.identity.fingerprint ? "VERIFIED" : "CHANGED";
  }

  async removeRecord(jobId: string): Promise<PreviewOutputHistorySnapshot> {
    if (!this.history.outputs.some((item) => item.jobId === jobId)) throw new Error("找不到要移除的預覽成品紀錄。");
    await this.mutate((outputs) => outputs.filter((item) => item.jobId !== jobId));
    return this.snapshot();
  }

  private async mutate(mutator: (outputs: StoredOutput[]) => StoredOutput[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const next: StoredHistory = {
        schemaVersion: 1,
        outputs: mutator(structuredClone(this.history.outputs)),
      };
      // Commit the in-memory snapshot only after its disk replacement succeeds.
      // Otherwise a failed save appears successful until the next restart.
      await this.saveNow(next);
      this.history = next;
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async saveNow(snapshot: StoredHistory = this.history): Promise<void> {
    const partial = `${this.historyPath}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(partial, this.historyPath);
    } finally {
      // A failed write/rename must not leave stray partial indexes behind.
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }
}
