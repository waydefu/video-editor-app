# SceneryWalker v0.88.0 — 第二輪操作、應用邏輯與安全稽核報告

**稽核日期：2026-11-28（台灣時間）｜交接對象：Claude Haiku / 開發者**

## GitHub 交接方式

本資料夾為獨立稽核交接資料，原始碼未修改。測試以 `.ts.txt` / `.tsx.txt` 保留原始內容，刻意放在 docs 而非正式 tests 目錄，避免尚未修復的「異常行為成立」測試被 CI 當成成功回歸。執行時在隔離 worktree 的 repository 根目錄複製，去除最後的 `.txt`：

```bash
# 先從稽核分支取得本資料夾；在要驗證的隔離 repository 根目錄執行
audit_dir="docs/audits/2026-11-28-round-2"
for f in "$audit_dir"/tests/*.txt; do
  name="$(basename "$f" .txt)"
  cp "$f" "tests/$name"
done
cp "$audit_dir/tests/renderer/audit-local-only.test.tsx.txt" tests/renderer/audit-local-only.test.tsx
npx vitest run tests/audit-local-only.test.ts tests/audit-ipc-local-only.test.ts tests/audit-r2-local-only.test.ts tests/renderer/audit-local-only.test.tsx -t 'OBSERVED BUG'
```

修復者依第 5 節選定工作包；把異常成立的斷言翻成正確期望後才納入正式測試。

## 1. 結論與範圍

**暫緩合併 PR #12。** 目前的新增專案功能可透過 File 選單操作，但不能只依照 happy path 判定安全。舊專案資料、來源唯讀承諾、跨專案背景作業及字幕審核授權需要先處理。這份報告不修改任何產品程式碼，不發送真實上傳、不執行關機、不建立或合併遠端 PR。

| 項目           | 固定稽核基準                                                                            |
| -------------- | --------------------------------------------------------------------------------------- |
| Repository     | waydefu/video-editor-app                                                                |
| PR             | [#12 New Project](https://github.com/waydefu/video-editor-app/pull/12)                  |
| 分支           | feat/new-project                                                                        |
| HEAD           | d8f31fae6bd5ee747f298ea29f07fd035a08efea                                                |
| PR base        | 4a5b63d105416f69870583f5955cdeb1edffb26a                                                |
| 版本           | v0.88.0                                                                                 |
| GitHub Actions | [Run 46125344307](https://github.com/waydefu/video-editor-app/actions/runs/46125344307) |
| 覆蓋           | 145 個 TS/TSX 來源檔、約 56,543 行；189 個 IPC channel 對應核查；兩輪定向流程/故障注入  |

### 判定分級

- **P0**：有實際資料毀損、來源檔被覆寫或不可接受的資料遺失；必須阻擋合併。
- **P1**：核心流程可能失效、跨專案污染、審核/授權失效或使用者難以恢復，優先修補。
- **P2**：可恢復但狀態錯亂、資源競爭、可用性降低。
- **P3**：提升健壯性、診斷與效能；不阻擋主功能。
- **已重現**＝附測試能在上述 HEAD 觸發異常；不代表每次正常操作都會發生。
- **靜態風險／待實機**＝原始碼有可疑時序或缺少保護，但未證明完整實際故障，不能當作既成事實。

## 2. 測試與可信度

| 驗證                                        | 結果                                                         | 說明                                                                   |
| ------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| GitHub Windows CI                           | 668 pass、1 skip；111 files pass、1 skip                     | 項目已存在的測試；Windows FFmpeg 8.1.2                                 |
| 本地全套原始測試                            | 620 pass、48 fail、1 skip；103 files pass、8 fail、1 skip    | 排除自建稽核重現測試；Linux FFmpeg 7.1.5                               |
| 第一輪定向回歸測試                          | 138 pass                                                     | 已包含多條既有核心流程，不再加算至全套結果                             |
| 第一輪故障重現                              | 17/17                                                        | 檔案、IPC Mock、React 流程                                             |
| 第二輪故障重現                              | 9/9                                                          | 新增遠端/更新/復原/輸出與匯入競態                                      |
| 合併重跑兩輪                                | 26 pass、90 skip、4 files pass                               | 90 是 -t 過濾掉複製的原 App 測試；不是 90 個未解決問題                 |
| Typecheck                                   | pass                                                         | renderer 與 main                                                       |
| Build                                       | pass                                                         | Vite 約 707.94 KB JS chunk 警告，非建置失敗                            |
| 真實 FFmpeg                                 | 使用 1 秒合成 H.264 影片執行兩個覆寫測試                     | 全為 temp fixtures；原始使用者素材未修改                               |
| LAN 遠端                                    | 模擬 HTTP transport、真實 pairing/session/handler/state 邏輯 | 容器拒絕介面列舉，不以真實 LAN 成功宣稱                                |
| Windows GUI、更新切換、真實 OAuth、超長轉檔 | 未證實                                                       | Linux 無可用 Electron GUI/Xvfb；未有實機 GPU/Windows 安裝/真實帳號驗證 |

本地 48 項失敗分布（不是額外 48 個確認 bug）：

| 測試                               | 失敗數 | 初步原因                                                                          |
| ---------------------------------- | -----: | --------------------------------------------------------------------------------- |
| concat-render.integration          |     25 | 大量 Windows 字型不可用；另有 FFmpeg encoder/filter/流程錯誤，需 Windows 重跑判別 |
| insertion-audio-render.integration |      1 | 本地 FFmpeg 環境與混音整合差異，待實機確認                                        |
| output-path                        |      1 | Windows 路徑字串與 POSIX basename 行為不同                                        |
| remote-control-server              |      6 | uv_interface_addresses 被容器拒絕                                                 |
| render-disk-space                  |      3 | Windows 磁碟/路徑與 Linux 不同                                                    |
| render-estimate                    |      1 | 磁碟預估環境差異，待比對                                                          |
| render-temp-scheduler              |      9 | Windows 路徑在 POSIX 被視為不是絕對路徑                                           |
| user-preferences                   |      2 | 預設磁碟與路徑遷移依 OS 不同                                                      |

Windows CI 通過不足以反證下列新測試；本地全套失敗也不足以認定 Windows 版本有 48 個問題。先修正已重現、可驗收的缺陷，再做 Windows 雙軌驗證。

## 3. 已重現缺陷（26 項）

行號以固定 HEAD 為準；修復中可能移動。禁止只把重現測試刪除或把錯誤行為改寫成「正確」測試。附件中 OBSERVED BUG 以異常成立為通過；修復者必須將對應斷言翻成期望行為，先在未修的 HEAD 確認紅燈、修復後綠燈。

### 3.1 第一輪（17）

| ID/級別      | 觀察與重現                                                                                 | 預期行為與驗收                                                                          | 根因定位                                                             |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R1-01 **P0** | 選擇某來源圖作縮圖輸出；以模擬 FFmpeg 產出，原圖由 14 bytes 變成 256 bytes                 | 任何輸出不能指向任一專案來源、BGM、素材來源或其硬連結/別名；阻擋前後來源 SHA-256 相同   | main/services/thumbnail-render.ts:22–76                              |
| R1-02 **P0** | 匯入兩支合成 MP4，排除其中一支於 Main 後，把成品指向被排除檔案；真 FFmpeg 成功覆寫         | 保護所有專案來源而不只實際參與渲染的 assets；原素材位元不變                             | main/services/concat-render.ts:2829 附近                             |
| R1-03 **P0** | 使 session pointer 路徑不可寫；New Project 報錯，記憶體仍為 A，但磁碟已變為 B；重啟 A 消失 | 新建、開啟、另存出錯時舊狀態完整；允許故障時復原至一致狀態                              | main/services/project-store.ts:700–721、731–733                      |
| R1-04 **P1** | A 匯入時，在 ADDING 進度觸發 New Project B；匯入結果進 B                                   | A 的工作不得寫進 B；阻擋切換或用 projectId+epoch 阻止提交                               | main/services/source-service.ts:58–147；main/ipc.ts:551–628          |
| R1-05 **P1** | A 匯入 BGM，等待 MediaProbe；切 B 再完成探測，B 被加入 A 音軌                              | 捕捉 projectId/epoch 並在 commit 鎖內驗證                                               | main/services/bgm-service.ts:15–57；main/ipc.ts BGM handlers         |
| R1-06 **P1** | 最後一個檔案的 ADDING 中 abort；回傳 cancelled=false 且仍新增                              | 取消在 commit 點前生效；取消後不新增、不更新 UI 成功狀態                                | main/services/source-service.ts:86–147                               |
| R1-07 **P1** | 未命名 A 只有 AI/設定等，點 New Project，未詢問便丟棄                                      | 判斷有意義內容含 AI、設定、時間線編輯、音訊、字幕、快取外的使用者資料；預設空白不誤警告 | renderer/App.tsx:515–545                                             |
| R1-08 **P1** | 未命名 A 有素材，點 Open 開別的專案；未先詢問保存/放棄/取消                                | New 與 Open 共用離開未命名專案 guard；取消保留原頁與編輯                                | renderer/App.tsx:553–570                                             |
| R1-09 **P1** | 匯入 Promise pending 時切到 B，A 舊回應完成後 setProject(A)                                | 丟棄過期回應、進度、placement queue、notice；UI 永遠與 main 的 active project 同步      | renderer/App.tsx:573–589、其他直接 setProject(result.project)        |
| R1-10 **P1** | 發起圖片 metadata probe，期間修改至 6000ms；probe 完成將圖片 duration 還原成 5000ms        | 只 patch probe 取得的技術欄位，保留使用者的編輯與刪除語意                               | main/services/source-service.ts:164–222；ProjectStore.updateAsset    |
| R1-11 **P1** | 無已確認字幕時 export 拋錯，之後 cancel 仍不能新建專案                                     | 校驗提前或完整 try/finally 釋放字幕控制器；不產生空檔；重試可行                         | main/ipc.ts:2874–2896                                                |
| R1-12 **P1** | 保存 AI draft、刪除該 cue、再 promote，仍寫出舊草稿                                        | draftCueIds 每筆必須存在、scope 相同且已確認；不存在不能當 CONFIRMED                    | main/ipc.ts:2924–2944                                                |
| R1-13 **P1** | A 保存草稿/授權 token，切 B，舊 token 仍可 promote A                                       | 字幕輸出 token 綁 projectId + generation；切換後失效，不能跨專案出稿                    | main/ipc.ts:2860–2944                                                |
| R1-14 **P1** | 保存 AI 原文草稿後人工改成 Human correction、確認，promote 實際仍寫 AI original            | 以實際已審核內容重新產生 SRT，或內容 hash 不同要求重新保存；正式 SRT 必須等於確認版本   | main/ipc.ts:2898–2944；main/services/subtitle-draft-store.ts:140–185 |
| R1-15 **P1** | 同一 App Data 初始化兩個 ProjectStore，各改不同欄位；後寫者覆蓋先寫者，重啟遺失設定        | App 單實例鎖；新 instance 聚焦既有 window；更新交接需確保舊進程退出；必要時檔案寫入鎖   | main/main.ts；main/services/project-store.ts                         |
| R1-16 **P1** | 兩次 YouTube upload 在 outputHistory.get 等待期間皆通過 busy，兩個 upload mock 被呼叫      | 無論點擊/UI、IPC、快速重試，最多一個 upload，controller 所有權正確                      | main/ipc.ts:2977–3030                                                |
| R1-17 **P2** | thumbnail FFmpeg 失敗，留下 .partial.png.txt                                               | 所有可預期失敗/cancel 都清除本 job 的 partial 與 text，不碰來源、不刪別人檔案           | main/services/thumbnail-render.ts:22–76                              |

### 3.2 第二輪（9）

| ID/級別      | 操作步驟／確定觀察                                                                                                                               | 修復驗收條件                                                                                                                                                         | 根因定位                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| R2-01 **P1** | 真實 pairing 建 session；POST start 只收到 header，body pending；停止遠端後才完成 JSON；handler 仍回 202 並啟動 render mock                      | 撤銷、停止、重新配對、過期後，尚未 dispatch 的命令全部拒絕 401/409；已開跑的合法 render 不因斷線而取消；重驗 session 是否仍在 Map、epoch 和 TTL，不只舊物件          | main/services/remote-control-server.ts:159–180,325–395；模擬 transport              |
| R2-02 **P2** | 並行 start()，第二次回 enabled=true，但沒有 port/pairingUrl                                                                                      | 同一 in-flight start promise，所有成功回傳均為完整狀態；並行 start/stop 不留下 phantom server 或 QR                                                                  | main/services/remote-control-server.ts:127–180                                      |
| R2-03 **P2** | 預備轉檔後 startPrepared，暫停在 preflight；snapshot 仍 PREPARED/true，第二次 start 卻被拒絕                                                     | 原子消耗 prepared request，呈現 PREFLIGHT/STARTING 或既有相容狀態、disable Start；失敗有可恢復提示；remote/desktop 同步                                              | main/services/render-command-state.ts:74–98,203–240                                 |
| R2-04 **P2** | 模擬已簽署新版，download→READY；verifiedArchive 驗證成功；點 Check 回 AVAILABLE，UI 的準備新版按鈕消失                                           | 已下載有效 staged 版本維持 READY，check 前驗證狀態或明確失效；新版本/損壞/準備中/armed 需定義優先順序                                                                | main/services/portable-update.ts:177–201；renderer/components/UpdateCenter.tsx:117  |
| R2-05 **P1** | 登錄成品的原始專案與時長；將檔案換成同大小的不同內容；get 仍 successful=true、exists=true 且保留舊專案及時長                                     | 修改/替換標記為 CHANGED 或需重新確認，不得繼承原成品可信度而直接供上傳；優先用 size/mtime 快篩，發佈關鍵操作再做可靠 fingerprint/驗證；大影片避免無條件逐次完整 hash | main/services/output-history.ts:145–176,260–277                                     |
| R2-06 **P1** | 存一個有效 .swproj，故意破壞內部 manifest JSON；重啟 initialize 拋錯，尚未嘗試 session 指到的完好檔案                                            | 先驗證權威 session/復原候選、備份故障位元，完整檔可復原；兩者都壞必須可控 UI 與明確選擇，不靜默覆蓋                                                                  | main/services/project-store.ts:578–629                                              |
| R2-07 **P0** | 真 FFmpeg 合成 MP4，FINALIZING callback 由另一程序模擬寫進原本空的 output path；成品覆寫新出現檔案。IPC auto output 只在 render 前拒絕已存在路徑 | 原子 no-clobber 提交，allowOverwrite=false 必須一直傳至所有輸出/取消/音訊/續傳 finalizer；若碰撞保留雙方資料並讓用戶重選，不用「最後一次 stat」假裝消除 TOCTOU       | main/ipc.ts:970,1015；main/services/concat-render.ts:3952–3957；atomic-output.ts:24 |
| R2-08 **P2** | 兩次 IPC render-benchmark:run 傳入 delayed run，兩個進入 benchmark                                                                               | benchmark 與 render、彼此的資源 admission 互斥；取得 gate 必須在首個 await 前；任何錯誤釋放資源                                                                      | main/ipc.ts:989–998                                                                 |
| R2-09 **P1** | 開始匯入 #1，另開 #2，#1 被 abort；#1 finally 先執行清掉全域 controller；點取消 #2，第二 signal 未 abort                                         | 每 job 保留自己的 controller，finally 只清除屬於本 job 的 controller；取消/進度不改錯 job；底層 commit 仍需 epoch 保護                                               | main/ipc.ts:613–625,796                                                             |

**說明：R2-01 不是未配對陌生人可任意執行，而是已配對但被撤銷的 request 在 await body 後仍有權執行。R2-07 測試 directly 進入真實 render service（既有接口不含 allowOverwrite）；自動輸出入口的前置 stat 與未向 service 傳政策為程式碼佐證。R2-05 测試用 bytes fixture 驗證 index 信任，不宣稱真的上傳了錯檔。**

## 4. 額外靜態風險與操作覆蓋

| ID      | 領域與風險／觀察                                                                                                                  | 下一步驗收                                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S-01 P1 | 停止/切換專案的 gate 只保護部分方向；許多異步 IPC 尚無 projectId/epoch 及同鎖檢查，ASR、AI、metadata、插入、預覽要逐 handler 盤點 | 在 await 前捕捉上下文，再在 mutation queue 裡驗證；不把 app-wide 設定/輸出歷史錯誤綁到 project；雙向競態測試           |
| S-02 P1 | 普通 Close IPC 主要檢查 renderPowerGuard，只有已 armed update 才 sealForUpdate；可能關閉在 import/AI/字幕或持久化途中             | 確認 Close/Exit/OS close/更新一致使用 activity barrier，未完成顯示原因，取消保留資料；驗證 renderer 的未存提醒互不打架 |
| S-03 P1 | postSuccessPower 忙碌定義只 renderPowerGuard.isActive (main.ts:85)；完成 render 後若 import/AI/專案寫入仍運作，排程可能忽略它們   | 模擬 power、絕不真關機，busy→延遲/取消；停止排程、關閉提示有效                                                         |
| S-04 P1 | OutputHistoryModal 對部分 canceled playable 仍顯示發佈；IPC 主要檢查 purpose；可能是刻意允許片段發布而非 bug                      | 明確對取消短片顯示「未完整」，要求 deliberate publish；保留使用者確實想發短片的功能，不任意移除                        |
| S-05 P2 | render 完成後 registerRender I/O 失敗（ipc.ts:1094/1277）可能使真實存在的成品被當作整個 render 失敗                               | 注入 history 寫入失敗；區分媒體已成功／紀錄失敗，顯示路徑和重建紀錄，避免無必要重轉檔                                  |
| S-06 P2 | probe / 子進程有 abort，但特定 I/O 遮蔽或 hang 需要界定超時；不可給合法長片 render 一刀切 timeout                                 | probe/網路有合理 deadline、取消、重試; 長片以 progress/heartbeat、動態 stall 偵測，不限制總時長                        |
| S-07 P2 | symlink、junction、hardlink、Windows 大小寫、正規化、長路徑的檔案別名會繞過單純 path 字串比較                                     | Windows 真實 NTFS 與 POSIX fixtures 對來源碰撞、輸出提交、save-as 做必要的實體識別                                     |
| S-08 P3 | 打包 chunk 707.94 KB，非 build regression 本身；長片、數百素材及 subtitle list 的資源使用未有本輪 GUI baseline                    | 先量測 cold start、拖曳、滾動、CPU/GPU/RAM、20 h render sample；沒有數據不做大重構                                     |

### 涵蓋模組逐項摘要

- **檔案/專案**：New/Open/Save/Save As、重啟指標、遷移、undo/redo、跨專案內容與持久化。New Project 是本 PR 主軸，P0/P1 在上述表。
- **匯入、Main/Intro、圖片插入、trim、zoom/色彩、BGM/SFX、音量**：原始 CI 測試已有大量覆蓋，重點查 asynchronous probe/import、取消、多來源不污染、路徑身份。未實機逐個點擊。
- **輸出、預覽、GPU/CPU、低記憶體、暫存/磁碟、checkpoint、取消/恢復**：實際短片輸出和最終碰撞；原始 CI 已驗證正常流程。未在實機跑 20h 或 GPU/跨磁碟。
- **字幕/AI**：已重現 draft promotion、空匯出、過期專案授權、編輯後正式輸出一致性。未用真實付費 AI API。
- **成品歷史、外部播放、平台發布**：確認檔案替換的身分/信任缺陷及雙送。未傳送任何遠端影片或操作真帳號。
- **iPhone/LAN、更新與關閉**：模擬 HTTP session/stream，以及簽章 fixture 更新狀態；實機網路、PowerShell/更新切換、關機、Windows UI 尚待。
- **介面與整合**：主程式、preload、renderer IPC 名稱對應核對，TypeScript/vite 通過。並未宣稱所有 handler 的參數/每條視覺路徑都做過動態驗證。全套原始測試與針對性重現已分別列明。

## 5. Haiku 可直接執行的分批 PR 計畫

### 作業策略

將每個工作包當成**獨立、小範圍、可回退 PR**。先不合併 #12。P0/P1 之中原本不屬於新專案功能但會造成資料毀損者，亦應在正式發布前修完。建議以 #12 HEAD 開本地整合分支 `audit/r2-integration`（尚未建立），由小 PR 依序針對此分支；小 PR 合併後下一個從最新 integration 起分支。待全部驗收後再由 maintainer 決定把 integration 合回 feat/new-project，更新 #12（不可 force-push 不明分支）。若 maintainer 選擇先修 main，僅把無 #12 依賴的小 PR target main，合併後再更新 #12，避免重複實作。所有分支/合併/發行均需主人批准；本報告不代開、不代合。

Haiku 執行時限制每個 PR 通常 2–5 個產品檔案、核心變動優先 <250 行（測試不限）；真的超過就回報並再拆，不必為硬行數犧牲安全。先讀關聯現存測試、使用既有規範、避免無關格式化、不要改 schema 除非必須有向後相容與遷移測試。不得用刪測試、禁用 safety guard、提高 timeout 掩蓋缺陷。以下 ID 同時當作驗收 checklist。

### 第一階段：阻擋資料破壞與跨專案污染（P0 優先）

#### PR-A01：保護所有來源檔，不允許覆寫（P0）

- 目標：R1-01、R1-02，含 S-07 的 path collision 部分。
- 核心檔：`src/main/services/thumbnail-render.ts`、`concat-render.ts`；若必要新增小型 `protected-output-path.ts`；`ipc.ts` 只在交給實際 service 之前補上下文；檢查 BGM、source、聲音/插入的外部引用。
- 做法：集中輸出路徑保護判定，比較 canonical path 與實際檔案身份（現存檔先 realpath、stat，必要時 device/inode；Windows 正規化與 case；不要誤禁安全的不同檔案）。縮圖正常輸出與轉檔選取來源之外的其他 source 一律禁止源檔重疊；即使使用者明示覆蓋普通舊成品，也不得覆蓋專案素材。不要為了修 bug 把來源複製或移動。
- 測試：R1-01/02 翻紅/綠；thumbnail 正常、轉檔正常；不同路徑同 inode、相同路徑/大小寫/alias，以及一般已確認覆蓋。比對 SHA-256。
- DoD：任一輸出路徑接觸來源立即報明確錯誤，所有來源 bytes 相同；既有合法 workflow 不變。

#### PR-A02：最終輸出原子 no-clobber（P0）

- 目標：R2-07；依賴 A01 的路徑保護 API。
- 核心檔：`atomic-output.ts`、`concat-render.ts`、`ipc.ts`；若 resume/checkpoint 綁定政策需要增加 shared domain，將該部分獨立小 commit。
- 做法：從 output token 一致攜帶 allowOverwrite，含 low-memory、normal、post-audio、cancelled playable、resume/checkpoint。切勿僅增加 stat 資料競態窗口。能採用同檔案系統原子 link/no-replace 或等價安全策略；若檔案系統不支援，明確失敗並保留 partial／可恢復資訊，不可 fallback 無保護 rename。明示覆蓋應在 commit 前重新保護來源身份。
- 測試：R2-07 翻為「外部檔案保持不變、輸出非成功且可恢復」，既有同名人工覆蓋仍須先確認；FFmpeg 成功、取消有效短片、失敗、移動磁碟、resume 完成亦測。
- DoD：以同步 callback 在 finalizing 創建衝突檔，無論時間均不得覆寫。清理只屬於本 job。

#### PR-A03：ProjectStore 切換交易與故障復原（P0）

- 目標：R1-03；先修一致性，R2-06 獨立 A04。
- 核心檔：`project-store.ts`、必要時持久化 helper；不動 UI。
- 做法：明確單一 authority/交易 journal/可回復 staging，避免 manifest 與 session pointer 半更新；新建、open、save-as 流程納入同一策略，成功後才發 changed event。在 pointer/manifest 任一步故障時，記憶體、有效檔、reopen 一致；不可用 catch 後強行宣布成功。檔案系統不是多檔交易，要處理崩潰點及下次啟動 repair。
- 測試：R1-03 逆向斷言；兩個順序的故障、保存/另存/開啟故障、重啟、原 .swproj hash、未命名專案。
- DoD：任一步失敗都不丟失上一個專案；無半新半舊，錯誤可恢復。

#### PR-A04：啟動復原與單實例（P1；可再拆 A04a/A04b）

- 目標：R2-06、R1-15；依賴 A03。
- 核心檔：`project-store.ts` / `main.ts`；必要時測試 helper。
- 做法：保全損毀的 manifest，依有效 session 或已知可復原候選復原，兩者壞時不自動覆蓋；Electron requestSingleInstanceLock，第二實例 focus 原 window；portable update 舊→新啟動握手不得被鎖誤殺；若需要先完成退出，再運行新版。
- 測試：故障 fixture、正常 restart、錯誤 pointer、只剩未命名專案；Windows 手動雙開與更新交接。不要只以雙 ProjectStore mock 代替實機單實例驗證。
- DoD：R2-06 可恢復；兩個 app 不再共用可寫 session。

#### PR-A05：共同離開專案確認（P1）

- 目標：R1-07/08。
- 核心檔：`src/renderer/App.tsx`；可提取 `project-leave-guard.ts`。
- 做法：New/Open 共用 save/discard/cancel；取消 Save As 不前進；使用比較「有效使用者編輯」的明確判定，包含 AI 設定與內容、timeline、影音設定、字幕、插入、BGM，排除純 derived/cache 欄位；已命名的自動儲存仍確認寫入成功。界面沿用當前繁中術語。
- 測試：三個選項、新空專案、僅 AI/設定、已有命名與儲存失敗、Open 對話框取消。不得把「有來源」當作唯一 dirty。
- DoD：未命名非空專案離開必問，取消不變更；Save 確實成功才切換。

#### PR-A06：主程式專案 context/epoch 與雙向 admission（P1）

- 目標：R1-04/05、S-01；依賴 A03。
- 核心檔：`ipc.ts`、`source-service.ts`、`bgm-service.ts`、`project-store.ts`；若過大先 A06a Source，A06b BGM，A06c 其他非同步 handlers。
- 做法：在開始 project-scoped job/開 dialog 時捕捉 project ID、generation；project switch 與 job admission 使用同一 gate。await 之後於 ProjectStore queue commit 內重驗；先切換與先匯入兩方向都測。區分 App scoped 讀取或 preference 等；避免只增加 UI disabled。對新建、打開、另存變更 projectId 的路徑皆使舊授權失效。
- 測試：R1-04/05、switch 時尚未結束 dialog、BGM/probe、cancel、拒絕後 gate 釋放；抑制舊事件。
- DoD：A 的 job 不可能提交進 B；正常完成 A 的作業切換仍可用。

#### PR-A07：Renderer 防止過期回應（P1）

- 目標：R1-09；依賴 A06。
- 核心檔：`App.tsx`，必要的小 helper。
- 做法：所有 async 更新捕捉 project ID/generation（另存分支也可能變 ID），比較 active ref、event 序號；過期結果不更新 project、progress、placement、notice、error；禁止把舊 result 的 finally 當作新 job busy 的終止。切換時清理 project-scoped view state，避免丟全域設定。
- 測試：deferred old A response / state event / progress；切 B 後仍 B；快速 A→B→A（ID 可重複但 generation 不同）；App UI tests。
- DoD：renderer 與 main 同步；舊 Promise 不可恢復舊時間線。

#### PR-A08：匯入取消與 controller 所有權（P1）

- 目標：R1-06、R2-09；依賴 A06。
- 核心檔：`source-service.ts`、`ipc.ts`。
- 做法：每次 import handle local const controller/jobId；only-owner finally 清理；最後一次 abort 在提交時驗證，不只每 loop 頂部；define partial cancel policy（本次尚未 commit 的 items 不提交，之前完成的 batch 明確報告）。
- 測試：第二 import signal 按取消變 true；最後檔 abort；初期掃描、commit 與取消競態；重試正常。
- DoD：不新增已取消 batch、不誤清 controller，UI 明確顯示結果。

#### PR-A09：非破壞性 metadata refresh（P1）

- 目標：R1-10；依賴 A06。
- 核心檔：`source-service.ts`、`project-store.ts`。
- 做法：只 patch probe 所產出的 codec/width/rotation/duration 等技術欄位；保留 user trim、imageDuration、style、sort、audio changes；relink、更換源、刪除、切專案時拒絕陳舊結果；若長度變短按既有安全 normalization 設計。
- 測試：6000 ms 不回退、trim/zoom/audio 不被覆蓋、asset 已刪或改 source 不復活、正常 metadata。
- DoD：延遲 probe 不覆蓋任何晚到使用者編輯。

### 第二階段：字幕審核、發布、遠端與更新

#### PR-B01：字幕匯出資源與 token project binding（P1）

- 目標：R1-11/13；依賴 A06。
- 核心檔：`ipc.ts`；必要 shared schema。
- 做法：guard 於 controller 設置前或 try/finally 完整覆蓋所有 paths；token 綁 projectId+generation+有效期；錯誤/取消/切換後安全清理，不影響另一 job。
- 測試：無已確認字幕不鎖住 new/open；逾期/切換 token 被拒、無輸出；重試成功；兩次 export 串行。
- DoD：無 controller leak，沒有跨專案字幕輸出。

#### PR-B02：字幕 draft promote 內容一致性（P1）

- 目標：R1-12/14；依賴 B01。
- 核心檔：`ipc.ts`、`subtitle-draft-store.ts`。
- 做法：確認每筆原 cue 存在與 scope；缺 ID 不假定 CONFIRMED（只有存在的 legacy cue 可遵循既有預設）；對已審 cue 的時碼、文字、scope 建立版本內容；使用最新確認版原子輸出或要求重新審核。如遇既有 SRT 保留 BACKUP/OVERWRITE/CANCEL 行為。
- 測試：刪除拒絕、修正後正式檔是 Human correction 而非 AI original；未確認拒絕，正確審核正常，備份保留原檔。
- DoD：正式檔等於實際已確認內容；token 無重放。

#### PR-B03：YouTube 上傳資源互斥（P1）

- 目標：R1-16。
- 核心檔：`ipc.ts`、可重用 admission 小 helper。
- 做法：在第一個 await 前 acquire 上傳 admission；前置校驗、路徑檢查、OAuth cancellation、上傳、後處理任何 exception 均釋放；同 controller 所有權原則。無須真上傳以測定。
- 測試：並行兩個 upload，最多一個進 service；拒絕、登入取消、上傳失敗後可重試；進度僅來自 owner。
- DoD：不得雙重發布/資源進程。

#### PR-B04：成品歷史的內容身分與明示短片發布（P1）

- 目標：R2-05；S-04/S-05 依範圍拆 follow-up。
- 核心檔：`output-history.ts`、`src/shared/domain.ts`、`ipc.ts`、`OutputHistoryModal.tsx`。
- 做法：紀錄文件身份/mtime/size/可信 fingerprint；舊 index 向後相容，缺證據顯示「需確認」而非 silently 可信；get/上傳/Chrome handoff 走一致的驗證，檔案替換後重新索引或明確確認。長片 hash 以安全且不阻塞 UI 的策略進行；避免修改或刪除 MP4。S-04 明示接受取消短片，由產品主人決策；先不要偷偷禁用既有合法用途。S-05 注入 registerRender 故障並區分成品成功。
- 測試：同尺寸替換、不同尺寸、離線、原檔正常、legacy index、模擬發布（不發實際請求）、index failure。
- DoD：原路徑存在不等於原作品可信；使用者可復原且不誤傳。

#### PR-B05：遠端 session 撤銷與 server 生命週期（P1）

- 目標：R2-01/02；若複雜拆成 B05a revocation、B05b lifecycle。
- 核心檔：`remote-control-server.ts`，測試 `remote-control-server.test.ts`。
- 做法：auth 完成後等 body，執行 command 前再次檢查 session 仍被 server 持有、TTL、generation、origin、必要 nonce；rotate/stop 使相應 epoch 失效，不取消已合法轉檔；start/stop 串行，成功狀態完整，停止中關閉或拒絕慢 body，有界等待並清理連線。
- 測試：已授權慢 body stop 後拒絕；expire/stop-restart、pairing/nonce replay；兩 start、start+stop、啟動失敗可重試；Windows LAN 實測。
- DoD：關閉後任何尚未執行的舊授權指令均不能執行，無半初始化狀態。

#### PR-B06：轉檔 PREPARED/preflight UI 與 benchmark admission（P2）

- 目標：R2-03/08；必要拆兩個 PR。
- 核心檔：`render-command-state.ts`、`ipc.ts`，遠端 UI/shared domain 僅最小相容改動。
- 做法：啟動 preflight 時原子消耗 prepared 並更新獨立狀態、同步桌面端與遠端、明確禁止重入；benchmark 共用 renderAdmission，自身和實際 render 雙向互斥，finally 釋放；預檢取消/失敗可重新準備。
- 測試：R2-03/08 逆向，preflight fail/成功、取消與 desktop/remote 一致；benchmark 先/轉檔先兩個方向測。
- DoD：顯示狀態符合操作，CPU/GPU 資源不被兩工作搶占。

#### PR-B07：更新 READY 狀態與重試（P2）

- 目標：R2-04。
- 核心檔：`portable-update.ts`、`UpdateCenter.tsx`。
- 做法：維護狀態優先序 DISABLED/CURRENT/AVAILABLE/READY/PREPARED/ARMED；check 已下載包仍可 prepare，必須保留原簽章、hash 驗證；下載中 check 不導致 UI 回退；損壞包正確提示與重下載；新版本出現時明確讓使用者決定用已驗證 staged 或新版。不要放寬 trusted host/版本/簽章。
- 測試：signed fake fixture READY→check→READY，壞包拒絕、download/check overlap、prepared/armed 正常、UI 按鈕可用；Windows portable smoke。
- DoD：已驗證包可持續使用，無狀態回退，安全驗證、舊版回退均保留。

#### PR-B08：縮圖 partial 清理（P2）

- 目標：R1-17；在 A01 後。
- 核心檔：`thumbnail-render.ts`。
- 做法：將 partial/text 建立、spawn、驗證、finalize 全放入同一 try/finally；清理屬於 job 自己的臨時檔；既有已完成輸出不被破壞。
- 測試：FFmpeg nonzero、spawn error、abort、finalize fail、成功；無 residual partial，來源 SHA-256 不變。
- DoD：錯誤及取消皆釋放資源。

### 第三階段：正常關閉與實機測試

#### PR-C01：關閉/更新/電源的一致 activity gate

- 目標：S-02、S-03。先針對已有 close/power 測試新增 fault injection，確認是否為 bug；若確認再改。
- 核心檔：`main.ts`、`ipc.ts`、`post-success-power.ts`。
- DoD：普通 close / update armed / post-success power 不在 project write、import、AI、upload、render in-flight 時意外終止；沒有工作時正常退出。電源操作全部 mock。

#### PR-C02：Windows smoke 與測試可攜性

- 目標：重跑 Windows 全套，釐清本地 48 failures、建立 Windows 手動/自動驗收清單；必要修真正跨平台測試，不改原始 Windows 預期以掩蓋問題。
- DoD：Windows CI build、typecheck、全套測試無新失敗；產物啟動、實際短片、休眠/喚醒後長片、USB/E:/C:/異磁碟、remote pairing、update rollback 驗收。實機限制須記載，不能將未測標成通過。

#### PR-C03（可選）：長時間可靠性與診斷

- 目標：S-06/S-08；基線後再修。記錄實際 progress heartbeat、處理程序、估算/磁碟 reserve、續傳、RAM、來源 hash、取消及清理，至少一個長工作 soak。不要盲目改 encoding 參數、保留所有 codec 與 GPU 支援。
- DoD：長片出現 stall 時可定位，不以任意總時間強制停止；效能回歸有可量測證據。

## 6. Haiku 單一工作包執行提示詞（可複製）

```text
你負責 SceneryWalker 稽核修復，僅處理我指定的 PR 工作包。
閱讀 README.md 稽核報告，基準 SHA d8f31fae6bd5ee747f298ea29f07fd035a08efea，
先確認目前分支與目標 HEAD、是否有工作樹變動及前置 PR 是否已合入。
如 HEAD 已更新，核對指定問題是否仍存在，不盲目修改。
先將附件對應 OBSERVED BUG 測試複製至隔離 worktree 執行。
測試通過是證明缺陷存在；將該測試的斷言翻成期望行為，先確認舊程式碼紅燈，
只修此 PR 指定範圍，再確認綠燈。不得提交將 bug 當作預期的 OBSERVED BUG 測試。
沿用現有 TypeScript、Vitest、Electron IPC、繁中 UI 與資料格式。
優先小修改，保留來源檔唯讀、原專案相容、取消/錯誤釋放與並行安全。
不更改未指定模組，不重構大檔案，不自動版本升級，不推送/合併/發行，
不用真實的 API token、影片上傳、關機、外部資料。若有 Windows 專屬測試，
標出本機限制並交給 Windows CI，不隱藏失敗或跳過既有測試。
執行定向 Vitest、npm run typecheck、npm run build、npm test；回報命令與真實結果。
交付：問題根因、實際修改檔案、回歸測試、仍有風險、PR title/body 和驗收清單。
若工作包過大、跨 schema 或需產品決策，先停在安全可回退的最小改動，提出下一個小 PR。
現在執行：PR-A01（或由主人替換為指定 ID）。
```

### PR 標題範本與提交規則

```text
fix(project): preserve current project on failed switch [R1-03]
fix(render): prevent overwriting protected source files [R1-01,R1-02]
fix(render): enforce no-clobber at commit [R2-07]
fix(remote): revoke pending commands on stop [R2-01]
```

PR body 必填：固定基準、涉及問題 ID、目前故障與重現步驟、紅→綠證據、修改清單、正常流程驗收、取消/失敗/競態驗收、未驗證平台與回退方式。不要一個 PR 同時放 A01–C03 的所有改動。

## 7. 附件與重跑說明

資料夾 tests/ 包含 4 份確認過的暫時稽核測試，共 26 個 OBSERVED BUG。不要直接將這些異常成立的測試合入 main。Renderer 檔包含原 App.test 的測試 scaffold 與增加的 3 個 cases；透過 -t 只執行故障重現，同樣可自行把 cases 移入正常測試檔。

在**獨立 clone/worktree** checkout 固定 SHA；使用原 lockfile 與專案既有 Node/npm，安裝依賴；FFmpeg/FFprobe 可用。兩個 mock-FFmpeg shell fixtures 針對 Linux，Windows regression 需以 node 可執行 mock/平台相容 fixture 等價改寫，其餘真 FFmpeg 為合成素材。不要對真實個人素材測試破壞性覆寫。

```bash
git rev-parse HEAD
npm ci
# 將本包中 tests/audit-*.test.ts 與 tests/renderer/audit-local-only.test.tsx
# COPY 到獨立 clone 的對應位置（勿覆蓋既有測試）
npx vitest run tests/audit-local-only.test.ts tests/audit-ipc-local-only.test.ts tests/audit-r2-local-only.test.ts tests/renderer/audit-local-only.test.tsx -t 'OBSERVED BUG'
# HEAD 未修時期望 26 passed | 90 skipped
npm run typecheck
npm run build
npm test -- --exclude '**/audit*local-only*'
```

對照：

- tests/audit-local-only.test.ts：R1-01/02/03/04/05/06/10/15/17、R2-07。
- tests/audit-ipc-local-only.test.ts：R1-11/12/13/14/16、R2-08/09。
- tests/renderer/audit-local-only.test.tsx：R1-07/08/09。
- tests/audit-r2-local-only.test.ts：R2-01–06（HTTP listener mock，真實 render state、auth/session、update signature 驗證、filesystem）。
- windows-ci-summary：已於第 2 節記錄，固定 run URL；本地完整失敗分類亦載於該節。附 tests-local-summary.txt 為此次全套實際 log 的 final/FAIL 摘要。

### Windows 最終操作驗收矩陣（修復完成後）

| 流程              | 明確驗收                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| 開啟 App + 新專案 | File/New Project 可見，空白；已有未命名內容時 Save/Discard/Cancel；存一個新 .swproj 不碰 A                      |
| 新建/開啟         | 開 A→建 B→重啟仍 B；重新開 A 內容一致，undo/redo 不串到 B                                                       |
| 取消與錯誤        | 檔案對話取消、權限錯誤、磁碟滿、正在保存/匯入/AI、斷掉 USB 後重啟均可恢復                                       |
| 來源只讀          | 縮圖/轉檔選原檔、被排除 Main 素材、BGM、junction/hardlink；禁止覆寫，hash 不變                                  |
| Final output      | 同名自動路徑碰撞拒絕、明示人工覆蓋正常、取消 partial/resume 都遵循政策                                          |
| 編輯              | 影片照片增刪、trim、Main/Intro、剪接移動、旋轉、9:16、zoom、BGM 淡入淡出、音量 automation；probe 延遲不回退     |
| 輸出              | CPU H264/H265；設備支援時 NVENC/QSV；360p/1080p/4K、手動路徑、自動名、低記憶體、多磁碟，輸出時長/A/V 正確       |
| 字幕/AI           | 逐批 draft、修訂、刪除與確認；未確認無正式輸出；新舊 project token 不交叉；空字幕錯誤後可切換                   |
| 遠端              | 正常配對、認證失敗、重放、停止、再配對、慢 body、遠端開始/暫停/恢復/雙確認取消，桌面狀態同步                    |
| 成品與發布        | 成品播放、外部打開、離線、替換或同名；partial 標明；模擬 YouTube 上傳雙擊、取消、重試；不發正式影片             |
| 更新              | 無更新/有更新、簽章失敗、下載 READY、check、prepare、arm、cancel、重新啟動與失敗回舊版；不得降版                |
| 資源/關閉         | benchmark 與 render 互斥；各工作中正常 close/更新/電源排程；timeout/低磁碟不靜默丟資料                          |
| 長片              | 隔離素材長時間 soak、磁碟 reserve、可用 GPU、記憶體、checkpoint、kill/restart、功耗；人工比對輸出時長與抽樣播放 |

## 8. 最終發布 Gate

- [ ] P0 R1-01、R1-02、R1-03、R2-07 全部紅→綠，來源 hash、原專案與外部碰撞檔保持原樣。
- [ ] P1 跨專案、取消、字幕、遠端撤銷、並行上傳全部通過安全測試。
- [ ] 維持 Windows 原有 CI 全綠，追加正常/失敗/並行回歸測試；測試不得僅證明 bug 存在。
- [ ] 手動驗證 File 的 New/Open/Save As 操作、關閉/更新/重啟與真實 Windows 來源只讀。
- [ ] 對 P2/P3 與未實機項目列出明確後續追蹤，不寫成「零 bug」。
- [ ] 不發布帶有可重現資料毀損的版本；由 maintainer 決定合併、版本號與發行。

**最終判斷：基本功能已實作，原始 Windows CI 也通過；然而基於 26 個具體重現，尚未達到可安心宣稱全面穩定的狀態。先完成 A01–A09 的資料與專案可靠性防護，再處理 B/C 階段。**
