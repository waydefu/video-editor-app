import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StandaloneSubtitleWorkspace, SubtitleCue } from "../../shared/domain";
import { serializeSrt } from "./subtitle-export";

const allowedVideos = new Map<string, string>();
export function authorizeSubtitleVideo(videoPath: string): string {
  const id = createHash("sha256").update(path.resolve(videoPath)).digest("hex");
  allowedVideos.set(id, path.resolve(videoPath));
  return `source-media://subtitle/${id}`;
}
export function resolveSubtitleVideo(id: string): string | undefined {
  return allowedVideos.get(id);
}

export class StandaloneSubtitleStore {
  constructor(private readonly root: string) {}
  private workspacePath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("獨立字幕工作區識別碼無效。");
    return path.join(this.root, id, "workspace.json");
  }
  async create(
    videoPath: string,
    videoFingerprint: string,
    videoDurationMs: number,
    cues: SubtitleCue[],
    source?: { projectId: string; timelineRevision: number },
    ownerProjectId?: string,
  ): Promise<StandaloneSubtitleWorkspace> {
    const id = createHash("sha256")
      .update(`${videoFingerprint}\0${source?.projectId ?? ownerProjectId ?? "legacy"}\0${randomUUID()}`)
      .digest("hex");
    const workspace: StandaloneSubtitleWorkspace = {
      id,
      videoPath,
      videoFingerprint,
      videoDurationMs,
      cues,
      draftPath: path.join(this.root, id, `${path.parse(videoPath).name}.ai-draft.srt`),
      updatedAt: new Date().toISOString(),
      ownerProjectId: source?.projectId ?? ownerProjectId,
      sourceProjectId: source?.projectId,
      sourceTimelineRevision: source?.timelineRevision,
    };
    return this.write(workspace);
  }
  async get(id: string): Promise<StandaloneSubtitleWorkspace> {
    const workspace = JSON.parse(await readFile(this.workspacePath(id), "utf8")) as StandaloneSubtitleWorkspace;
    if (workspace.id !== id || !Array.isArray(workspace.cues)) throw new Error("獨立字幕工作區格式無效。");
    workspace.previewUrl = authorizeSubtitleVideo(workspace.videoPath);
    return workspace;
  }
  private latestPointerPath(projectId?: string): string {
    if (!projectId) return path.join(this.root, "latest.json"); // Preserve legacy drafts without auto-assigning them.
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(projectId)) throw new Error("字幕專案識別碼無效。");
    return path.join(this.root, "latest-by-project", `${projectId}.json`);
  }
  async latest(projectId?: string): Promise<StandaloneSubtitleWorkspace | null> {
    try {
      const pointer = JSON.parse(await readFile(this.latestPointerPath(projectId), "utf8")) as { id?: string };
      if (!pointer.id) return null;
      const workspace = await this.get(pointer.id);
      if (projectId && (workspace.ownerProjectId ?? workspace.sourceProjectId) !== projectId) return null;
      return workspace;
    } catch {
      if (projectId) {
        // Safely expose pre-migration *project-linked* drafts, never arbitrary global VIDEO_FIRST drafts.
        const legacy = await this.latest();
        return legacy?.sourceProjectId === projectId ? legacy : null;
      }
      return null;
    }
  }
  async save(id: string, cues: SubtitleCue[]): Promise<StandaloneSubtitleWorkspace> {
    return this.write({ ...(await this.get(id)), cues, updatedAt: new Date().toISOString() });
  }
  private async atomic(filePath: string, text: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const partial = `${filePath}.${randomUUID()}.partial`;
    await writeFile(partial, text, { encoding: "utf8", flag: "wx" });
    await rename(partial, filePath);
  }
  private async write(workspace: StandaloneSubtitleWorkspace): Promise<StandaloneSubtitleWorkspace> {
    const sorted = [...workspace.cues].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length; i++) {
      const cue = sorted[i];
      if (
        !Number.isFinite(cue.startMs) ||
        !Number.isFinite(cue.endMs) ||
        cue.startMs < 0 ||
        cue.endMs <= cue.startMs ||
        cue.endMs > workspace.videoDurationMs ||
        !cue.text.trim() ||
        (i > 0 && cue.startMs < sorted[i - 1].endMs)
      )
        throw new Error("字幕時間必須依序、不重疊且位於所選影片內。");
    }
    workspace.cues = sorted;
    await this.atomic(this.workspacePath(workspace.id), JSON.stringify(workspace, null, 2));
    await this.atomic(workspace.draftPath, sorted.length ? serializeSrt(sorted) : "");
    await this.atomic(this.latestPointerPath(workspace.ownerProjectId), JSON.stringify({ id: workspace.id }));
    workspace.previewUrl = authorizeSubtitleVideo(workspace.videoPath);
    return structuredClone(workspace);
  }
  async validateSource(workspace: StandaloneSubtitleWorkspace): Promise<void> {
    const file = await stat(workspace.videoPath);
    const fingerprint = createHash("sha256")
      .update(`${workspace.videoPath}\0${file.size}\0${file.mtimeMs}`)
      .digest("hex");
    if (fingerprint !== workspace.videoFingerprint) throw new Error("分析影片已變更，請重新分析後再使用此工作區。");
  }
}
