// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateCenter } from "../../src/renderer/components/UpdateCenter";
import type { AppUpdateStatus } from "../../src/shared/domain";

afterEach(() => {
  delete (window as unknown as { sourceApp?: unknown }).sourceApp;
});

describe("UpdateCenter", () => {
  it("keeps the prepare button after checking again while a verified package is READY", async () => {
    const ready: AppUpdateStatus = {
      state: "READY",
      currentVersion: "0.88.0",
      latestVersion: "0.89.0",
      message: "更新套件已下載及驗證，可在完成工作後手動切換。",
    };
    const checkAppUpdate = vi.fn(async () => ready);
    (window as unknown as { sourceApp: unknown }).sourceApp = { checkAppUpdate };
    render(<UpdateCenter version="0.88.0" />);
    fireEvent.click(screen.getByRole("button", { name: "軟體版本 0.88.0" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "準備新版並檢查啟動" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "檢查更新" }));
    await waitFor(() => expect(checkAppUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "準備新版並檢查啟動" })).toBeTruthy());
  });
});
