import { EventEmitter } from "node:events";
import type {
  ConcatRenderProgress,
  ConcatRenderRequest,
  ConcatRenderResult,
  RemotePreparedRender,
  RemoteRenderSnapshot,
} from "../../shared/domain";

export interface PreparedRenderRecord extends RemotePreparedRender {
  request: ConcatRenderRequest;
}

export interface RenderCommandHandlers {
  startPrepared(request: ConcatRenderRequest): Promise<ConcatRenderResult>;
  resumeCheckpoint(): Promise<ConcatRenderResult>;
  cancel(): Promise<void>;
}

function redactLocalPaths(message: string): string {
  return message.replace(/[A-Za-z]:\\[^\r\n"']+/g, "[本機路徑已隱藏]");
}

/**
 * Main-process authority shared by Electron IPC and the LAN adapter.  It never
 * exposes an FFmpeg process handle; commands are routed back through the same
 * checked render entry points used by the desktop UI.
 */
export class RenderCommandState {
  private readonly events = new EventEmitter();
  private revision = 0;
  private jobGeneration = 0;
  private launchPending = false;
  private prepared?: PreparedRenderRecord;
  private handlers?: RenderCommandHandlers;
  private pauseRequested = false;
  private pauseWaiters: Array<() => void> = [];
  private snapshotValue: RemoteRenderSnapshot;

  constructor(projectName: string) {
    this.snapshotValue = this.blank(projectName);
  }

  private blank(projectName: string): RemoteRenderSnapshot {
    return {
      revision: ++this.revision,
      capturedAt: new Date().toISOString(),
      projectName,
      state: "IDLE",
      prepared: false,
      progressPercent: 0,
    };
  }

  setHandlers(handlers: RenderCommandHandlers): void {
    this.handlers = handlers;
  }

  setProjectName(projectName: string): void {
    this.patch({ projectName });
  }

  resetProject(projectName: string): void {
    this.prepared = undefined;
    this.jobGeneration += 1;
    this.snapshotValue = this.blank(projectName);
    this.events.emit("snapshot", this.snapshot());
  }

  currentJobGeneration(): number {
    return this.jobGeneration;
  }

  prepare(request: ConcatRenderRequest, outputDisplayPath: string): RemotePreparedRender {
    if (this.launchPending || ["RUNNING", "PAUSING", "PAUSED"].includes(this.snapshotValue.state))
      throw new Error("已有轉檔工作正在進行。");
    const record: PreparedRenderRecord = {
      request: structuredClone(request),
      preparedAt: new Date().toISOString(),
      outputDisplayPath,
      resolution: request.resolution,
      renderMode: request.lowMemorySegmented ? "LOW_MEMORY" : request.highSpeedMode ? "HIGH_SPEED" : "NORMAL",
      audioMode: request.audioProcessing?.mode ?? "ORIGINAL_STEREO",
    };
    this.prepared = record;
    this.patch({
      state: "PREPARED",
      prepared: true,
      progressPercent: 0,
      resolution: record.resolution,
      renderMode: record.renderMode,
      audioMode: record.audioMode,
      latestError: undefined,
    });
    return this.publicPrepared(record);
  }

  clearPrepared(): void {
    this.prepared = undefined;
    if (this.snapshotValue.state === "PREPARED") this.patch({ state: "IDLE", prepared: false });
    else this.patch({ prepared: false });
  }

  getPrepared(): RemotePreparedRender | undefined {
    return this.prepared ? this.publicPrepared(this.prepared) : undefined;
  }

  snapshot(): RemoteRenderSnapshot {
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: (snapshot: RemoteRenderSnapshot) => void): () => void {
    this.events.on("snapshot", listener);
    return () => this.events.off("snapshot", listener);
  }

  markStarting(request: ConcatRenderRequest): void {
    this.jobGeneration += 1;
    this.pauseRequested = false;
    this.prepared = undefined;
    this.patch({
      state: "RUNNING",
      prepared: false,
      progressPercent: 0,
      attemptElapsedMs: undefined,
      cumulativeElapsedMs: undefined,
      estimatedRemainingMs: undefined,
      currentSegment: undefined,
      encoder: undefined,
      cpuUsagePercent: undefined,
      gpuEncodeUsagePercent: undefined,
      ramUsedBytes: undefined,
      ramAvailableBytes: undefined,
      ssdFreeBytes: undefined,
      resolution: request.resolution,
      renderMode: request.lowMemorySegmented ? "LOW_MEMORY" : request.highSpeedMode ? "HIGH_SPEED" : "NORMAL",
      audioMode: request.audioProcessing?.mode ?? "ORIGINAL_STEREO",
      latestError: undefined,
      pauseDetail: undefined,
    });
  }

  markResuming(mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED"): void {
    this.jobGeneration += 1;
    this.pauseRequested = false;
    this.prepared = undefined;
    this.patch({
      state: "RUNNING",
      prepared: false,
      progressPercent: this.snapshotValue.progressPercent,
      renderMode: mode,
      latestError: undefined,
      pauseDetail: undefined,
    });
  }

  updateProgress(progress: ConcatRenderProgress): void {
    const resources = progress.resourceUsage;
    this.patch({
      state: this.pauseRequested && this.snapshotValue.state !== "PAUSED" ? "PAUSING" : this.snapshotValue.state,
      progressPercent: progress.percent,
      attemptElapsedMs: progress.attemptElapsedMs,
      cumulativeElapsedMs: progress.cumulativeElapsedMs,
      estimatedRemainingMs: progress.estimatedRemainingMs,
      currentSegment: progress.currentSegment,
      encoder: resources?.encoderName,
      cpuUsagePercent: resources?.cpuUsagePercent,
      gpuEncodeUsagePercent: resources?.gpuEncodeUsagePercent,
      ramUsedBytes: resources
        ? Math.max(0, resources.totalRamBytes - resources.availableRamBytes)
        : this.snapshotValue.ramUsedBytes,
      ramAvailableBytes: resources?.availableRamBytes,
      ssdFreeBytes: resources?.outputDriveFreeBytes,
    });
  }

  markTerminal(result: ConcatRenderResult): void {
    this.pauseRequested = false;
    this.releasePauseWaiters();
    this.patch({
      state: result.cancelled ? "CANCELLED" : "COMPLETED",
      prepared: false,
      progressPercent: result.cancelled ? this.snapshotValue.progressPercent : 100,
      attemptElapsedMs: result.attemptElapsedMs,
      cumulativeElapsedMs: result.cumulativeElapsedMs,
      estimatedRemainingMs: result.cancelled ? undefined : 0,
      pauseDetail: undefined,
    });
  }

  markFailed(error: unknown): void {
    this.pauseRequested = false;
    this.releasePauseWaiters();
    this.patch({
      state: error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
      prepared: false,
      estimatedRemainingMs: undefined,
      latestError: redactLocalPaths(error instanceof Error ? error.message : String(error)),
      pauseDetail: undefined,
    });
  }

  async startPrepared(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    if (!this.prepared) throw new Error("Windows 端尚未準備可供遠端啟動的轉檔工作。");
    if (
      this.snapshotValue.state === "RUNNING" ||
      this.snapshotValue.state === "PAUSING" ||
      this.snapshotValue.state === "PAUSED"
    )
      throw new Error("目前已有轉檔工作執行中。");
    if (this.launchPending) throw new Error("轉檔正在預檢，請稍候。");
    const request = structuredClone(this.prepared.request);
    this.prepared = undefined;
    this.launch(() => this.handlers!.startPrepared(request));
  }

  async resumeCheckpoint(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    if (this.snapshotValue.state === "PAUSED" || this.snapshotValue.state === "PAUSING") {
      this.resumeFromPause();
      return;
    }
    if (this.snapshotValue.state === "RUNNING") throw new Error("目前轉檔沒有暫停。");
    this.launch(() => this.handlers!.resumeCheckpoint());
  }

  private launch(operation: () => Promise<ConcatRenderResult>): void {
    if (this.launchPending) throw new Error("轉檔正在預檢，請稍候。");
    this.launchPending = true;
    const generation = this.jobGeneration;
    void operation()
      .catch((error) => {
        // A rejected competing command must not mark another job as failed.
        if (generation === this.jobGeneration && !["RUNNING", "PAUSING", "PAUSED"].includes(this.snapshotValue.state))
          this.markFailed(error);
      })
      .finally(() => {
        this.launchPending = false;
      });
  }

  requestPause(): void {
    if (this.snapshotValue.state !== "RUNNING") throw new Error("目前沒有可暫停的轉檔工作。");
    this.pauseRequested = true;
    this.patch({ state: "PAUSING", pauseDetail: "等待目前 FFmpeg 分段完成後暫停，不會強制掛起或終止編碼器。" });
  }

  async waitAtSafeBoundary(signal?: AbortSignal, detail = "已在安全分段邊界暫停"): Promise<void> {
    if (!this.pauseRequested) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pauseWaiters = this.pauseWaiters.filter((waiter) => waiter !== done);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      // Register before publishing PAUSED: subscribers may synchronously resume.
      this.pauseWaiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.patch({ state: "PAUSED", pauseDetail: detail });
    });
  }

  resumeFromPause(): void {
    if (!this.pauseRequested && this.snapshotValue.state !== "PAUSED" && this.snapshotValue.state !== "PAUSING")
      throw new Error("目前轉檔沒有暫停。");
    this.pauseRequested = false;
    this.patch({ state: "RUNNING", pauseDetail: undefined });
    this.releasePauseWaiters();
  }

  async cancel(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    this.pauseRequested = false;
    this.releasePauseWaiters();
    await this.handlers.cancel();
  }

  private publicPrepared(record: PreparedRenderRecord): RemotePreparedRender {
    const { request: _request, ...publicRecord } = record;
    return structuredClone(publicRecord);
  }

  private releasePauseWaiters(): void {
    for (const waiter of this.pauseWaiters.splice(0)) waiter();
  }

  private patch(patch: Partial<RemoteRenderSnapshot>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: ++this.revision,
      capturedAt: new Date().toISOString(),
    };
    this.events.emit("snapshot", this.snapshot());
  }
}
