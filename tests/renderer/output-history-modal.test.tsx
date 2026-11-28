// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OutputHistoryModal } from "../../src/renderer/components/OutputHistoryModal";
import type { PreviewOutputIdentityState, PreviewOutputRecord } from "../../src/shared/domain";

function record(identityState: PreviewOutputIdentityState): PreviewOutputRecord {
  return {
    jobId: "legacy-job",
    outputPath: "C:/legacy.mp4",
    fileName: "legacy.mp4",
    purpose: "CONCAT",
    origin: "APP_RENDERED",
    createdAt: "2026-09-09T02:00:00Z",
    sizeBytes: 100,
    resolution: "480P",
    projectName: "Old project",
    durationMs: 20_000,
    successful: identityState !== "CHANGED",
    exists: identityState !== "MISSING",
    identityState,
  };
}

function mountModal(initial: PreviewOutputRecord) {
  const api = {
    getPreviewOutputHistory: vi.fn(async () => ({ schemaVersion: 1 as const, outputs: [initial] })),
    confirmPreviewOutputIdentity: vi.fn(async () => ({ ...initial, identityState: "VERIFIED" as const })),
    playConcatOutput: vi.fn(),
    revealConcatOutput: vi.fn(),
    copyPreviewOutputPath: vi.fn(),
  };
  Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
  const view = render(<OutputHistoryModal onClose={vi.fn()} onOpenYoutubeSettings={vi.fn()} />);
  return { api, view };
}

describe("output history identity confirmation", () => {
  it("shows the confirm action for an UNVERIFIED legacy record and hides publish buttons until confirmed", async () => {
    const { api, view } = mountModal(record("UNVERIFIED"));
    const article = (await screen.findByRole("heading", { name: "legacy.mp4" })).closest("article") as HTMLElement;
    expect(within(article).getByRole("button", { name: "確認此檔案" })).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "YouTube API" })).toBeNull();
    expect(api.confirmPreviewOutputIdentity).not.toHaveBeenCalled();
    view.unmount();
  });

  it("shows a confirmation step for a CHANGED record with 取消 as the default, then confirms and reveals publish buttons", async () => {
    const { api, view } = mountModal(record("CHANGED"));
    const article = (await screen.findByRole("heading", { name: "legacy.mp4" })).closest("article") as HTMLElement;
    expect(within(article).getByText(/大小、修改時間或內容與登錄時不同/)).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "YouTube API" })).toBeNull();

    fireEvent.click(within(article).getByRole("button", { name: "確認此檔案" }));
    const step = within(article).getByRole("alert");
    expect(step.textContent).toContain("接受目前這個檔案就是此筆成品");
    const cancel = within(step).getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
    expect(api.confirmPreviewOutputIdentity).not.toHaveBeenCalled();

    fireEvent.click(within(step).getByRole("button", { name: "確認此檔案" }));
    await waitFor(() => expect(api.confirmPreviewOutputIdentity).toHaveBeenCalledWith("legacy-job"));
    await waitFor(() => expect(within(article).getByRole("button", { name: "YouTube API" })).toBeTruthy());
    expect(within(article).queryByRole("alert")).toBeNull();
    expect(screen.getByText("已確認此檔案為這筆成品；現在可以使用上傳與投稿功能。")).toBeTruthy();
    view.unmount();
  });

  it("closes the confirmation step with 取消 without calling the main process", async () => {
    const { api, view } = mountModal(record("UNVERIFIED"));
    const article = (await screen.findByRole("heading", { name: "legacy.mp4" })).closest("article") as HTMLElement;
    fireEvent.click(within(article).getByRole("button", { name: "確認此檔案" }));
    fireEvent.click(within(article).getByRole("button", { name: "取消" }));
    expect(within(article).getByRole("button", { name: "確認此檔案" })).toBeTruthy();
    expect(within(article).queryByRole("alert")).toBeNull();
    expect(api.confirmPreviewOutputIdentity).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not offer confirmation for a verified record", async () => {
    const { view } = mountModal(record("VERIFIED"));
    const article = (await screen.findByRole("heading", { name: "legacy.mp4" })).closest("article") as HTMLElement;
    expect(within(article).queryByRole("button", { name: "確認此檔案" })).toBeNull();
    expect(within(article).getByRole("button", { name: "YouTube API" })).toBeTruthy();
    view.unmount();
  });
});
