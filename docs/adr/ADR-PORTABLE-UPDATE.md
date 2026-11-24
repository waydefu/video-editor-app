# Windows 版本更新：可攜版安全下載與正式安裝版規劃

## 決策

現有 Electron Packager 的可攜版保留。Electron / electron-builder 文件明確區分可攜手動更新與 NSIS 安裝版更新；不能把普通 dist ZIP 當安裝器。先交付正式 Windows 封裝啟動時的版本檢查、更新中心、簽署套件背景下載與獨立暫存，新版準備階段會安全解壓與隔離 smoke；不會強制關閉或覆蓋現有 App。

來源：

- https://www.electronjs.org/docs/latest/api/auto-updater
- https://www.electron.build/docs/targets/
- https://www.electron.build/docs/features/auto-update/
- https://www.electron.build/docs/features/security/

## 啟用方式（倉庫維護者）

1. 離線生成 Ed25519 金鑰對，例如 `openssl genpkey -algorithm ED25519 -out private.pem`、`openssl pkey -in private.pem -pubout -out public.pem`。保留私鑰離線備份，禁止提交任何私鑰。首個信任版本必須透過可信管道取得，且核對公開金鑰。
2. Repository Actions variables：`ENABLE_SIGNED_PORTABLE_RELEASE=true`、`SCENERYWALKER_UPDATE_PUBLIC_KEY_PEM`（完整公開 PEM）。Repository Actions secrets：`SCENERYWALKER_UPDATE_PRIVATE_KEY_BASE64`（私鑰 PEM 的 base64）、`SCENERYWALKER_SHUTTER_MP3_BASE64`（既有授權素材的 base64；受 GitHub secret 大小限制，超出則需另建授權素材供應流程）。
3. 審核 tag 與 package.json 版本一致；從受保護的正式 tag 執行 release。CI 使用既有音效 checksum gate、Windows 封裝 smoke、完整程式測試，再打包及簽署 JSON manifest。沒有 opt-in 時仍只發布既有 dist。
4. 首次支援更新的簽署版須手動下載。其後 App 僅信任內建 Ed25519 公鑰，拒絕任意 URL、非正式版本、降版、錯誤簽章及 SHA-256 不符套件。GitHub Actions 簽署權限與 tag 保護仍須治理。

## 使用者安全

ZIP 下載到 userData/updates，原安裝、專案、成品及 checkpoint 不覆蓋。使用者可準備新版：Windows ZIP 以同一唯讀 handle 核對 hash 並解壓到新目錄，拒絕路徑逸出、裝置名稱、重複路徑及過量資料；以隔離 userData 執行封裝 smoke，保存完整檔案樹 hash。確認安排切換後，使用原有正常關閉流程；主程序拒絕在 IPC、轉檔預檢及背景工作尚未完成時切換，封鎖新 IPC，重新核對檔案樹，再安排 Electron relaunch。舊版保留，準備失敗不改正式資料。尚未保證新版正式資料 migration 後可安全降版，未實作正式資料自動回滾或差量更新。

## 後續正式自動更新

以 NSIS 安裝版為獨立目標，使用 electron-updater、鎖定依賴、Authenticode 及簽署 manifest、blockmap 差量更新；需可取得正式 Windows 簽署憑證、CI 封裝和兩版本真機驗證。設置主程序全域作業准入鎖、未保存編輯與上傳／轉檔檢查、明確同意後退出並套用。測試斷電、下載中斷、簽章失效、金鑰輪替、重啟健康及回滾前不得啟用自動安裝。禁止將可攜 ZIP 直接當作 NSIS 更新。

## 驗收

本 PR 新增純程式測試，尚未配置倉庫簽署秘密或發布新的正式 Windows 套件。CI 與實機結果必須分別記錄。

## 可攜版切換驗收限制

隔離 smoke 不是正式專案的兩版本驗收。切換安排僅當次執行有效，不在 OS 關機時強制執行。需以正式簽署套件驗證 Windows 解壓、IPC 空閒閘、正常重啟及舊版保留；不宣稱已完成正式熱更。
