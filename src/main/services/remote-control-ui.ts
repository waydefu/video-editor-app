export const REMOTE_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>SceneryWalker 遠端控制</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <header>
      <p class="brand">SceneryWalker</p>
      <h1>遠端轉檔控制</h1>
      <p id="connection" role="status">正在配對…</p>
    </header>
    <section class="card" aria-labelledby="project">
      <h2 id="project">等待連線</h2>
      <div class="progress-summary">
        <strong id="percent">—</strong>
        <span id="segment"></span>
      </div>
      <progress id="progress" max="100" aria-label="轉檔進度"></progress>
      <span class="sr-only" id="progressAnnouncement" role="status"></span>
      <dl class="times">
        <div><dt>已耗時</dt><dd id="elapsed">—</dd></div>
        <div><dt>目前階段剩餘</dt><dd id="eta">—</dd></div>
      </dl>
    </section>
    <p class="error" id="error" role="alert"></p>
    <section class="actions" aria-label="轉檔操作">
      <button class="primary" data-command="start" disabled>開始轉檔</button>
      <button class="primary" data-command="pause" hidden disabled>安全暫停</button>
      <button class="primary" data-command="resume" hidden disabled>繼續</button>
      <button class="cancel" data-command="cancel" hidden disabled>取消轉檔</button>
    </section>
    <p class="note" id="actionStatus" role="status"></p>
    <p class="note" id="pauseDetail"></p>
    <details id="details" hidden>
      <summary>轉檔詳情</summary>
      <dl class="grid" id="metrics"></dl>
    </details>
  </main>
  <dialog id="cancelDialog" aria-labelledby="cancelTitle">
    <h2 id="cancelTitle">確定取消轉檔？</h2>
    <p>目前分段會依安全流程結束或保存續轉點。</p>
    <div class="dialog-actions">
      <button id="keep" autofocus>保留工作</button>
      <button id="confirmCancel" class="cancel">確定取消</button>
    </div>
  </dialog>
  <script src="/app.js"></script>
</body>
</html>`;

export const REMOTE_CSS = `:root {
  color-scheme: dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #edf2f6;
  background: #081016;
  line-height: 1.5;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
    max(20px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
main { max-width: 35rem; margin-inline: auto; }
h1, h2, p, dl, dd { margin: 0; }
h1 { font-size: 1.375rem; line-height: 1.25; margin-block: 2px 4px; }
h2 { font-size: 1.5rem; line-height: 1.25; overflow-wrap: anywhere; }
.brand { color: #c6f36b; font-size: 0.875rem; font-weight: 700; }
#connection, dt, .note, #segment { color: #a9bfd0; }
.card, details, .error {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid #385065;
  border-radius: 12px;
  background: #101a22;
}
.progress-summary { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
#percent { font-size: 2rem; font-variant-numeric: tabular-nums; }
progress {
  display: block;
  width: 100%;
  height: 12px;
  overflow: hidden;
  border: 0;
  border-radius: 12px;
  accent-color: #c6f36b;
  background-color: #293944;
}
progress::-webkit-progress-bar { background-color: #293944; }
progress::-webkit-progress-value { background-color: #c6f36b; }
.times, .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 7.5rem), 1fr)); gap: 8px 12px; }
.times, .grid { margin-top: 10px; }
.times dd, .grid dd { font-size: 1.1rem; font-variant-numeric: tabular-nums; font-weight: 700; overflow-wrap: anywhere; }
.actions, .dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.actions button, .dialog-actions button { flex: 1 1 8rem; }
button, summary {
  min-height: 58px;
  min-width: min(100%, 48px);
  border-radius: 10px;
  font: inherit;
  font-weight: 700;
}
button {
  padding: 8px 12px;
  border: 1px solid #567083;
  color: #fff;
  background: #233341;
  cursor: pointer;
}
button.primary { background: #2358c5; }
button.cancel { color: #ffd2d6; border-color: #a84d55; }
dialog button.cancel { background: #a52236; color: #fff; }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, summary:focus-visible { outline: 3px solid #c6f36b; outline-offset: 2px; }
summary { min-height: 48px; padding-block: 12px; cursor: pointer; }
details { padding-block: 0; }
details[open] { padding-bottom: 14px; }
.note { font-size: 0.9375rem; margin-top: 8px; }
.note:empty { margin: 0; }
.error:empty { margin: 0; padding: 0; border: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.error { border-color: #a84d55; color: #ffd2d6; overflow-wrap: anywhere; }
dialog { max-width: min(30rem, calc(100% - 32px)); max-height: calc(100% - 32px); color: inherit; background: #101a22; border: 1px solid #567083; border-radius: 12px; }
dialog::backdrop { background: #081016b3; }
dialog p { margin-top: 8px; }`;

export const REMOTE_JS = String.raw`(() => {
  const get = (id) => document.getElementById(id);
  const buttons = [...document.querySelectorAll("[data-command]")];
  const dialog = get("cancelDialog");
  const localStates = {
    IDLE: "待命", PREPARED: "可開始", PREFLIGHT: "預檢中", RUNNING: "轉檔中", PAUSING: "正在暫停",
    PAUSED: "已暫停",
    COMPLETED: "已完成", CANCELLED: "已取消", FAILED: "轉檔失敗",
  };
  const cancelStates = ["RUNNING", "PAUSING", "PAUSED"];
  const resumeStates = ["PAUSING", "PAUSED", "FAILED", "CANCELLED"];
  const message = (id, value) => { if (get(id).textContent !== value) get(id).textContent = value; };
  let csrf = sessionStorage.getItem("scenery-csrf");
  let cancelNonce;
  let snapshot;
  let lastUpdated;
  let connected = false;
  let pendingCommand = false;
  let progressStep;

  function clock(ms) {
    if (ms == null) return "—";
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }
  const bytes = (n) => n == null ? "—" : (n / 1073741824).toFixed(1) + " GB";
  const percent = (n) => n == null ? "—" : Math.round(n) + "%";

  function updateActions() {
    const state = snapshot?.state;
    const allowed = {
      start: !!snapshot?.prepared && !cancelStates.includes(state),
      pause: state === "RUNNING",
      resume: resumeStates.includes(state),
      cancel: cancelStates.includes(state),
    };
    for (const button of buttons) {
      const command = button.dataset.command;
      button.hidden = command === "start" ? allowed.pause || allowed.resume || allowed.cancel : !allowed[command];
      button.disabled = !connected || pendingCommand || !allowed[command];
    }
    get("confirmCancel").disabled = !connected || pendingCommand;
  }

  function render(s, live = true) {
    snapshot = s;
    lastUpdated = new Date().toLocaleTimeString("zh-TW");
    if (live) {
      connected = true;
      message("connection", "已連線 · " + (localStates[s.state] || "狀態更新中"));
    }
    message("project", s.projectName || "未命名專案");
    const progress = Math.max(0, Math.min(100, s.progressPercent || 0));
    get("progress").value = progress;
    message("percent", percent(progress));
    const step = Math.floor(progress / 10);
    if (live && step !== progressStep && (s.state === "RUNNING" || s.state === "COMPLETED")) {
      progressStep = step;
      message("progressAnnouncement", "轉檔進度 " + percent(progress));
    }
    message("elapsed", clock(s.attemptElapsedMs));
    message("eta", clock(s.estimatedRemainingMs));
    message("segment", s.currentSegment || "");
    message("pauseDetail", cancelStates.includes(s.state)
      ? (s.pauseDetail || "安全暫停會先完成目前分段。")
      : (s.state === "IDLE" && !s.prepared ? "請先在 Windows 設定要轉檔的工作。" : ""));
    const rows = [
      ["編碼器", s.encoder], ["解析度", s.resolution], ["轉檔模式", s.renderMode], ["音訊模式", s.audioMode],
      ["CPU", percent(s.cpuUsagePercent)], ["GPU 編碼", percent(s.gpuEncodeUsagePercent)],
      ["記憶體用量", bytes(s.ramUsedBytes)], ["SSD 可用空間", bytes(s.ssdFreeBytes)],
    ];
    const metrics = get("metrics");
    rows.forEach(([label, value], index) => {
      let row = metrics.children[index];
      if (!row) {
        row = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        row.append(term, document.createElement("dd"));
        metrics.append(row);
      }
      const description = row.lastElementChild;
      const text = value ?? "—";
      if (description.textContent !== text) description.textContent = text;
    });
    get("details").hidden = false;
    showError(s.latestError || "");
    updateActions();
  }

  function showError(text) {
    message("error", text);
  }

  function disconnect(label) {
    connected = false;
    message("connection", lastUpdated ? label + " · 上次更新 " + lastUpdated : label);
    if (dialog.open) dialog.close();
    cancelNonce = undefined;
    updateActions();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(csrf && { "X-Scenery-CSRF": csrf }) },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "操作失敗，請重試。"), { status: response.status });
    return result;
  }

  async function pair() {
    const fragment = location.hash.startsWith("#pair=") ? location.hash.slice(6) : "";
    history.replaceState(null, "", location.pathname);
    if (!fragment) throw new Error("請在 Windows 端重新產生 QR Code，再用手機掃描。");
    const data = await api("/api/pair", { method: "POST", body: JSON.stringify({ token: decodeURIComponent(fragment) }) });
    csrf = data.csrfToken;
    sessionStorage.setItem("scenery-csrf", csrf);
  }

  async function runCommand(name, data = {}) {
    if (!connected || pendingCommand) return;
    pendingCommand = true;
    showError("");
    message("actionStatus", "正在送出指令…");
    updateActions();
    try {
      const result = await api("/api/command/" + name, { method: "POST", body: JSON.stringify(data) });
      if (name === "cancel-intent") {
        if (connected) {
          cancelNonce = result.cancelNonce;
          dialog.showModal();
        }
        message("actionStatus", "");
      } else {
        const state = await api("/api/state");
        render(state.render, connected);
        message("actionStatus", "指令已送出。");
      }
    } catch (error) {
      if (error.status === 401) disconnect("配對已失效");
      showError(error.message);
      message("actionStatus", "");
    } finally {
      pendingCommand = false;
      updateActions();
    }
  }

  async function events() {
    const response = await fetch("/api/events", { headers: { "X-Scenery-CSRF": csrf } });
    if (!response.ok || !response.body) throw Object.assign(new Error("即時連線中斷"), { status: response.status });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("即時連線結束");
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const packet = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = packet.split("\n").find((line) => line.startsWith("data:"));
          if (data) render(JSON.parse(data.slice(5)));
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  for (const button of buttons) {
    button.onclick = () => runCommand(button.dataset.command === "cancel" ? "cancel-intent" : button.dataset.command);
  }
  get("keep").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { cancelNonce = undefined; });
  get("confirmCancel").onclick = () => {
    const nonce = cancelNonce;
    dialog.close();
    if (nonce) void runCommand("cancel", { confirmation: "CANCEL", cancelNonce: nonce });
  };

  (async () => {
    try {
      if (location.hash.startsWith("#pair=") || !csrf) await pair();
      render((await api("/api/state")).render);
      for (;;) {
        try {
          await events();
        } catch (error) {
          if (error.status === 401) throw new Error("配對已失效，請重新掃描 Windows 端的 QR Code。");
          disconnect("即時狀態中斷，正在重連");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      disconnect("未連線");
      showError(error instanceof TypeError ? "無法連線。請確認手機和電腦在同一網路，再重新開啟配對連結。" : error.message);
    }
  })();
})();`;
