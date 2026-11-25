import { useEffect, useState } from "react";
import type { RemoteControlStatus } from "../../shared/domain";
import { formatBytes, formatRenderClock } from "../format";
import { SafeDefaultButton } from "./SafeDefaultButton";

export function RemoteControlModal({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<RemoteControlStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.sourceApp
      .getRemoteControlStatus?.()
      .then(setStatus)
      .catch((reason) => setError(String(reason)));
    window.sourceApp.onRemoteControlStatus?.(setStatus);
    return () => window.sourceApp.clearRemoteControlStatusListeners?.();
  }, []);

  const run = async (operation: "ENABLE" | "DISABLE" | "ROTATE") => {
    setBusy(true);
    setError(undefined);
    try {
      const next =
        operation === "ENABLE"
          ? await window.sourceApp.enableRemoteControl?.()
          : operation === "DISABLE"
            ? await window.sourceApp.disableRemoteControl?.()
            : await window.sourceApp.rotateRemotePairing?.();
      if (next) setStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const render = status?.render;
  return (
    <div className="modal-backdrop remote-control-backdrop" role="presentation">
      <section className="modal remote-control-modal" role="dialog" aria-modal="true" aria-labelledby="remote-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow">LOCAL NETWORK ONLY</span>
            <h2 id="remote-title">iPhone 遠端控制</h2>
          </div>
          <SafeDefaultButton type="button" className="icon-button" onClick={onClose} aria-label="關閉遠端控制設定">
            ×
          </SafeDefaultButton>
        </header>
        <div className="editor-modal-body">
          <div className="remote-security-note">
            <strong>只開放同一 LAN／Wi-Fi</strong>
            <p>
              只綁定畫面列出的單一私人 LAN IP，不開放 Internet，也不提供檔案瀏覽。QR Code
              內是十分鐘有效、只能使用一次的配對憑證；手機取得的控制連線也會自動過期。第一次啟動時 Windows
              防火牆可能詢問，請只允許私人網路。本功能使用未加密 HTTP，請勿在公共 Wi-Fi 或不受信任的 LAN 使用。
            </p>
          </div>
          {!status?.enabled ? (
            <div className="remote-disabled-state">
              <p>啟動後會顯示本機 IP、臨時 Port 與 QR Code。iPhone Safari 斷線不會中斷 Windows 轉檔。</p>
              <button className="primary-button" type="button" disabled={busy} onClick={() => void run("ENABLE")}>
                {busy ? "正在啟動…" : "啟動 iPhone 遠端控制"}
              </button>
            </div>
          ) : (
            <>
              <div className="remote-pairing-grid">
                <div className="remote-qr-card">
                  {status.qrDataUrl ? (
                    <img src={status.qrDataUrl} alt="iPhone 遠端控制配對 QR Code" />
                  ) : (
                    <div className="remote-paired">
                      此 QR Code 已使用
                      <br />
                      如需連線另一支手機，請重新產生。
                    </div>
                  )}
                </div>
                <div className="remote-addresses">
                  <strong>iPhone Safari 連結</strong>
                  {(status.addresses.length ? status.addresses : ["127.0.0.1"]).map((address) => (
                    <code key={address}>
                      http://{address}:{status.port}
                    </code>
                  ))}
                  {status.pairingExpiresAt && status.qrDataUrl && (
                    <small>QR 有效至 {new Date(status.pairingExpiresAt).toLocaleTimeString("zh-TW")}</small>
                  )}
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("ROTATE")}>
                    重新產生一次性 QR
                  </button>
                  <button className="danger-button" type="button" disabled={busy} onClick={() => void run("DISABLE")}>
                    停止遠端控制
                  </button>
                </div>
              </div>
              {render && (
                <section className="remote-pc-snapshot">
                  <div>
                    <strong>{render.projectName}</strong>
                    <span>{render.state}</span>
                  </div>
                  <progress max="100" value={render.progressPercent} />
                  <div className="remote-pc-metrics">
                    <span>
                      進度 <b>{Math.round(render.progressPercent)}%</b>
                    </span>
                    <span>
                      已耗時{" "}
                      <b>{render.attemptElapsedMs === undefined ? "—" : formatRenderClock(render.attemptElapsedMs)}</b>
                    </span>
                    <span>
                      目前階段預估剩餘{" "}
                      <b>
                        {render.estimatedRemainingMs === undefined
                          ? "—"
                          : formatRenderClock(render.estimatedRemainingMs)}
                      </b>
                    </span>
                    <span>
                      RAM 可用{" "}
                      <b>{render.ramAvailableBytes === undefined ? "—" : formatBytes(render.ramAvailableBytes)}</b>
                    </span>
                  </div>
                  {render.pauseDetail && <p className="notice warning">{render.pauseDetail}</p>}
                </section>
              )}
            </>
          )}
          {error && <div className="notice error">{error}</div>}
        </div>
      </section>
    </div>
  );
}
