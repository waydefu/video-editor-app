# CLAUDE.md

SceneryWalker 素材整理（`package.json` name：`scenerywalker-source-organizer`）：Windows 優先的 Electron + React + TypeScript 影片素材整理／剪輯 App。目前版本 **0.88.0**（Node >= 22）。

## 常用指令（取自 package.json scripts）

| 指令                                 | 用途                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `npm ci`                             | 安裝相依（CI 同樣用這個）                            |
| `npm run dev`                        | 開發模式（`node scripts/dev.mjs`）                   |
| `npm run build`                      | clean + `tsc -p tsconfig.main.json` + vite build     |
| `npm run typecheck`                  | renderer 與 main 兩份 tsconfig 的型別檢查            |
| `npm run format:check`               | prettier 檢查（改完檔先 `npx prettier --write`）     |
| `npm test` / `npx vitest run <檔案>` | 測試；本機只跑相關的少數檔，完整測試交給 CI          |
| `npm run smoke`                      | Electron 冒煙測試                                    |
| `npm run package:win`                | build 後打包 Windows 版（`scripts/package-win.mjs`） |
| `npm run smoke:packaged`             | 打包版冒煙測試                                       |

CI：`.github/workflows/ci.yml`（job `verify`，矩陣 ffmpeg `8.1.2` 與 `latest`，所以檢查名稱為 `verify (8.1.2)`）。步驟：npm ci、`npm audit --audit-level=high`、format:check、typecheck、`npx vitest run`、build。另有 `release.yml`。

## 目錄地圖

- `src/main/`：Electron 主程序。`main.ts` 啟動、`preload.ts` 橋接 API、`ipc.ts` 所有 IPC handler、`services/` 約 74 個檔案（轉檔、字幕、AI、偏好設定、專案儲存等）。
- `src/renderer/`：React UI。`App.tsx`、`styles.css`、`components/`（約 36 個元件）。
- `src/shared/`：main 與 renderer 共用的型別（`domain.ts`）與純函式規則（排序、時間軸、字幕文字、輸出畫布等）。
- `tests/`：vitest 測試（約 88 個項目）；`tests/renderer/` 是 React 元件測試、`tests/shared/` 是共用函式測試。
- `docs/`：文件（見下）。
- `scripts/`：開發、清理、冒煙、截圖、打包與各版本驗證用腳本（`.mjs`／`.cjs`／`.ps1`）。
- 根目錄：`README.md`、`CURRENT_PRODUCT_SPEC.md`（產品規格入口）、`vite.config.mts`、`vitest.config.mts`、`tsconfig.main.json`、`tsconfig.renderer.json`。

## 不要整份讀（先 Grep 定位，再用 offset/limit 分段讀）

| 檔案                                            | 行數              |
| ----------------------------------------------- | ----------------- |
| `src/renderer/styles.css`                       | 9869              |
| `src/renderer/components/ConcatRenderModal.tsx` | 4212              |
| `src/main/services/concat-render.ts`            | 4146              |
| `src/renderer/components/SubtitleStudio.tsx`    | 3014              |
| `src/main/ipc.ts`                               | 2953              |
| `src/shared/domain.ts`                          | 2556              |
| `README.md`                                     | 629 行（約 90KB） |
| `CURRENT_PRODUCT_SPEC.md`                       | 347 行（約 58KB） |

（行數為 2026-11-23 以 `wc -l` 實測，之後會變動。）

## docs/ 簡述

- `adr/`：架構決策紀錄（`0001-…` 起編號，另有一份 `ADR-011-…`）。
- `*_REPORT.md`（`V080_`～`V088_` 等）：各版本的復原／驗證報告。
- `*WORKING_NOTES*.md`（`PERF_`、`RESOURCE_…_V077`、`V088_SUBTITLE_REVIEW_`）：特定版本的工作筆記，內容多半綁定舊版本；是否完全過時：未確認。
- `VERIFICATION.md`、`CHANGELOG.md`、`PHASE_0_ARCHITECTURE.md`、`*_AUDIT_*.md`：驗證紀錄、變更紀錄、架構邊界、稽核；`*.json` 為基準測試或分析資料。

## 規則

- 合併到 `main` 需要 PR，且 `verify (8.1.2)` 通過（GitHub ruleset「Protect main」強制；Repository admin 可繞過，不要依賴繞過）。
- 不要提交金鑰；測試用假金鑰要明顯是假值（例如 `fake-key-for-test`）。
