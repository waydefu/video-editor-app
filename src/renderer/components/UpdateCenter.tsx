import { useEffect, useState } from "react";
import type { AppUpdateStatus } from "../../shared/domain";
import { SafeDefaultButton } from "./SafeDefaultButton";

export function UpdateCenter({ version }: { version?: string }) {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<AppUpdateStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const check = window.sourceApp.checkAppUpdate;
    if (check) {
      setBusy(true);
      void check()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => {
      active = false;
    };
  }, []);

  const run = async (action: "CHECK" | "DOWNLOAD" | "SHOW" | "RELEASE" | "PREPARE" | "ARM" | "DISARM") => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === "CHECK") {
        const next = await window.sourceApp.checkAppUpdate?.();
        if (next) setStatus(next);
      } else if (action === "DOWNLOAD") {
        const next = await window.sourceApp.downloadAppUpdate?.();
        if (next) setStatus(next);
      } else if (action === "PREPARE") {
        const next = await window.sourceApp.prepareAppUpdate?.();
        if (next) setStatus(next);
      } else if (action === "ARM") {
        const next = await window.sourceApp.armAppUpdate?.();
        if (next) setStatus(next);
      } else if (action === "DISARM") {
        const next = await window.sourceApp.disarmAppUpdate?.();
        if (next) setStatus(next);
      } else if (action === "SHOW") await window.sourceApp.showAppUpdateArchive?.();
      else await window.sourceApp.openAppUpdateRelease?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const available = status && ["AVAILABLE", "MANUAL", "READY", "PREPARED", "ARMED"].includes(status.state);
  return (
    <>
      <button
        className="version-pill"
        type="button"
        aria-label={`軟體版本 ${version ?? "讀取中"}`}
        title="軟體版本與更新"
        onClick={() => setVisible(true)}
      >
        版本 v{version ?? "…"}
        {available ? " · 有新版" : ""}
      </button>
      {visible && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal remote-control-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
            <header>
              <div>
                <span className="eyebrow">SCENERYWALKER</span>
                <h2 id="update-title">版本與更新</h2>
              </div>
              <SafeDefaultButton
                type="button"
                className="close-button"
                onClick={() => setVisible(false)}
                aria-label="關閉更新"
              >
                ×
              </SafeDefaultButton>
            </header>
            <div className="remote-security-note" aria-live="polite">
              <strong>目前版本 v{version ?? "…"}</strong>
              {status?.latestVersion && <p>正式發布版本 v{status.latestVersion}</p>}
              <p>{busy ? "正在處理更新，請勿關閉程式。" : (status?.message ?? "尚未檢查更新。")}</p>
              {busy && <progress aria-label="更新作業進行中" />}
              {error && <p role="alert">{error}</p>}
              <p>
                新版會解壓至獨立目錄並以隔離資料測試啟動。請先保存所有編輯，完成轉檔與上傳，再正常關閉舊版切換。
                舊程式保留；若新版已修改資料格式，不能保證直接降版相容。
              </p>
            </div>
            <div className="remote-disabled-state">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("CHECK")}>
                檢查更新
              </button>
              {status?.state === "AVAILABLE" && (
                <button className="primary-button" type="button" disabled={busy} onClick={() => void run("DOWNLOAD")}>
                  下載已簽署新版
                </button>
              )}
              {status?.state === "READY" && (
                <>
                  <button className="primary-button" type="button" disabled={busy} onClick={() => void run("PREPARE")}>
                    準備新版並檢查啟動
                  </button>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("SHOW")}>
                    顯示已驗證套件
                  </button>
                </>
              )}
              {status?.state === "PREPARED" && (
                <button className="primary-button" type="button" disabled={busy} onClick={() => void run("ARM")}>
                  下次正常關閉時切換
                </button>
              )}
              {status?.state === "ARMED" && (
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("DISARM")}>
                  取消切換安排
                </button>
              )}
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("RELEASE")}>
                官方發布頁
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
