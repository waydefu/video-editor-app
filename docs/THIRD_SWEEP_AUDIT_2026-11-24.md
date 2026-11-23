# 第三輪可靠性大掃 — 2026-11-24

目標：`waydefu/video-editor-app`。基準為已合併 PR #1、#3、#4 的 `main` (`fa33c1b`)。
本次只在 `fix/third-sweep-reliability-20261124` 修改，**不刪除使用者影片、TEMP 中繼檔、checkpoint、原始字幕或既有專案資料**。

## 已確認的缺陷與修補

1. **Process stdio 提早結束**：`runProcess` 原先在 Node `ChildProcess.exit` 事件即回傳，此事件可能早於 stdout/stderr 管線讀取完成。改在 `close` 完成，避免 FFprobe/PowerShell 等外部程序的尾段輸出被截斷；新增順序可控的測試。
2. **預覽輸出歷史寫入失敗時狀態分裂**：`OutputHistoryStore.mutate` 原先先替換記憶體紀錄，再寫磁碟；若寫入失敗，App 顯示新紀錄而重開又消失。改為先完成磁碟原子寫入，再發布記憶體狀態；每次使用獨立 partial 名稱，失敗後清除 partial，並加入故障注入測試。
3. **無法備份壞掉的歷史索引時，可能覆寫原檔**：`initialize` 先前即使移動舊檔備份失敗，仍可能寫入空索引。現在在備份失敗時明確拒絕覆寫；能備份時則保留原始損壞內容供人工復原，加入保留原始位元組的測試。
4. **CI FFmpeg 版本假陽性**：Windows CI 原先僅查 Chocolatey 指令成功且 PATH 有 `ffmpeg`，未確認與 8.1.2 matrix 標籤相符。現在檢查實際版本第一行；另外將 CI 權限明確設為 `contents: read`。
5. **稽核文件狀態過期**：補本報告與歷史文件註記；PR #1/#3/#4 已合併，不應繼續以草稿未合併的文字描述現在狀態。

## 驗證界限

- **程式碼檢查**：已核對上述呼叫路徑、已有保護與回歸測試，修補範圍聚焦在可確定的錯誤。
- **自動化測試**：新增 `tests/process-runner-drain.test.ts`、`tests/output-history-failures.test.ts`。完整 `npx vitest run`、Prettier、TypeScript、Build 與兩組 Windows FFmpeg CI，以本 PR 最新 HEAD 的實際結果為準，不預先宣稱通過。
- **實機未驗收**：20 小時長片速度、跨 C:/E: 磁碟續轉、GPU 硬體路徑、YouTube 真實 OAuth/上傳、AI 真實額度、Windows 可攜封裝/啟動，以及舊使用者專案 A→B→A。這些不能由單元測試綠燈推出。
- **保留的架構風險**：字幕 workspace JSON、SRT 和 latest pointer 為多檔提交，缺少跨斷電交易式一致性保證。未取得設計及實機測試前，不冒然合併為破壞相容性的資料格式。

## 合併門檻

- 最新 PR HEAD 的 Windows CI `verify (8.1.2)` 及 `verify (latest)` 均綠燈。
- 若此 PR 的故障注入測試或既有整合測試紅燈，先修復再考慮合併。
- CI 通過僅表示程式與自動化測試可用，**不代表 Windows 最終封裝與使用者長影片輸出已驗收**。
