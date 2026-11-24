// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OutputLibrary, useOutputLibrary } from "../../src/renderer/components/OutputLibrary";
import type { PreviewOutputRecord } from "../../src/shared/domain";

const outputs: PreviewOutputRecord[] = [
  {
    jobId: "main",
    outputPath: "C:/main.mp4",
    fileName: "main.mp4",
    purpose: "CONCAT",
    origin: "APP_RENDERED",
    createdAt: "2026-09-09T02:00:00Z",
    sizeBytes: 100,
    resolution: "480P",
    exists: true,
  },
  {
    jobId: "unknown",
    outputPath: "C:/old.mp4",
    fileName: "old.mp4",
    purpose: "UNKNOWN",
    origin: "IMPORTED_EXISTING",
    createdAt: "2026-09-09T01:00:00Z",
    sizeBytes: 200,
    resolution: "4K",
    exists: true,
  },
  {
    jobId: "intro",
    outputPath: "C:/intro.mp4",
    fileName: "intro.mp4",
    purpose: "INTRO",
    origin: "APP_RENDERED",
    createdAt: "2026-09-09T03:00:00Z",
    sizeBytes: 300,
    resolution: "720P",
    exists: true,
  },
];

describe("shared output library", () => {
  it("filters purpose and routes shared play/reveal/copy actions", async () => {
    const api = {
      getPreviewOutputHistory: vi.fn(async () => ({ schemaVersion: 1 as const, outputs })),
      playConcatOutput: vi.fn(async () => ({ status: "OPENED" as const, target: "CACHE_PROXY" as const })),
      revealConcatOutput: vi.fn(async () => undefined),
      copyPreviewOutputPath: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<OutputLibrary purpose={["CONCAT", "UNKNOWN"]} title="正片成品" recentOnly={false} />);
    const region = await screen.findByRole("region", { name: "正片成品" });
    expect(within(region).getByText("main.mp4")).toBeTruthy();
    expect(within(region).getByText("old.mp4")).toBeTruthy();
    expect(within(region).queryByText("intro.mp4")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "main.mp4" }));
    fireEvent.click(within(region).getAllByRole("button", { name: "開啟位置" })[0]);
    await waitFor(() => expect(api.revealConcatOutput).toHaveBeenCalledWith("main"));
    fireEvent.click(within(region).getAllByRole("button", { name: "複製路徑" })[0]);
    await waitFor(() => {
      expect(api.playConcatOutput).toHaveBeenCalledWith("main");
      expect(api.copyPreviewOutputPath).toHaveBeenCalledWith("main");
    });
  });

  it("keeps missing output files out of the playable compact list", async () => {
    const api = {
      getPreviewOutputHistory: vi.fn(async () => ({
        schemaVersion: 1 as const,
        outputs: [{ ...outputs[0], exists: false }],
      })),
      playConcatOutput: vi.fn(),
      revealConcatOutput: vi.fn(),
      copyPreviewOutputPath: vi.fn(),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<OutputLibrary purpose="CONCAT" title="可用成品" />);
    expect(await screen.findByText("尚無仍存在的預覽檔。")).toBeTruthy();
    expect(api.playConcatOutput).not.toHaveBeenCalled();
  });

  it("shows loading rather than a false empty state and reports read errors with retry", async () => {
    let rejectRead!: (reason: Error) => void;
    const pending = new Promise<{ schemaVersion: 1; outputs: PreviewOutputRecord[] }>((_resolve, reject) => {
      rejectRead = reject;
    });
    const api = {
      getPreviewOutputHistory: vi.fn(() => pending),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    const view = render(<OutputLibrary title="Loading check" />);
    const region = within(screen.getByRole("region", { name: "Loading check" }));
    expect(region.getByText("正在讀取預覽成品紀錄…")).toBeTruthy();
    expect(region.queryByText("尚無仍存在的預覽檔。")).toBeNull();
    await act(async () => {
      rejectRead(new Error("磁碟讀取失敗"));
    });
    expect(region.getByRole("alert").textContent).toContain("磁碟讀取失敗");
    expect(region.getByRole("button", { name: "重新讀取成品紀錄" })).toBeTruthy();
    expect(region.queryByText("尚無仍存在的預覽檔。")).toBeNull();
    view.unmount();
  });

  it("does not let a pending read overwrite a newer mutation or refresh", async () => {
    type Snapshot = { schemaVersion: 1; outputs: PreviewOutputRecord[] };
    let resolveOld!: (snapshot: Snapshot) => void;
    const pending = new Promise<Snapshot>((resolve) => {
      resolveOld = resolve;
    });
    const api = {
      getPreviewOutputHistory: vi.fn(() => pending),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    const hook = renderHook(() => useOutputLibrary());
    act(() => hook.result.current.setOutputs([outputs[1]]));
    await act(async () => resolveOld({ schemaVersion: 1, outputs: [outputs[0]] }));
    expect(hook.result.current.outputs).toEqual([outputs[1]]);
    expect(hook.result.current.loading).toBe(false);
    hook.unmount();
  });
});
