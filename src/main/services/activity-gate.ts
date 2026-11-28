/** Snapshot of work that must finish before the app closes, updates, or powers off. */
export interface ActivityState {
  renderInFlight: boolean;
  renderPreflight: boolean;
  projectSwitching: boolean;
  /** Imports, intro, AI, subtitles, audio previews, uploads and preview generation. */
  backgroundWork: boolean;
}

/**
 * One shared check for close, armed update and post-success power. Returns a
 * user-facing reason when work is in flight, or undefined when the app is idle.
 */
export function activityBlockReason(state: ActivityState): string | undefined {
  if (state.renderInFlight) return "轉檔仍在進行中";
  if (state.renderPreflight) return "轉檔準備作業仍在進行中";
  if (state.projectSwitching) return "專案正在開啟或另存";
  if (state.backgroundWork) return "匯入、AI、字幕、上傳或預覽仍在進行中";
  return undefined;
}
