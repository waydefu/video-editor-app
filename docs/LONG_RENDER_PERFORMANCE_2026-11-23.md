# 長影片轉檔 20 小時：v0.88 靜態根因研究與保守修正

日期：2026-11-23
倉庫：`waydefu/video-editor-app`
目標：分辨 **事前理論時間高估**、**實際 FFmpeg 處理速度**、**分段安全策略**，在不更動影片內容、畫質、checkpoint 或來源檔前提下減少誤判並提供安全的加速選擇。

## 已確認的程式行為

1. `render-estimate.ts` 的 `REALTIME_FACTOR` 是固定假設，不是使用者電腦的量測值。4K H.265 CPU 為 `8.0`、4K H.264 CPU 為 `4.0`；4K QSV 亦是固定係數。原本還以 **原始輸入總數**增加最終 `graphFactor`，即使大型時間線已在中繼階段縮減成少數輸入；且用來源解碼負擔評估已正規化的中繼層。
2. `user-preferences.ts` 現有預設是 `LOW_DISK`，`render-resource.ts` 定義每批 **4 個輸入、1 個工作**。若輸入 100 段，可能需要 25 → 7 → 2 組中繼，再做 final master；此流程保護 RAM／TEMP 及斷點續轉，卻可能延長實際轉檔。
3. `concat-render.ts` 的 Leaf 中繼會正規化畫面與音訊，較後 reduction 層已使用 `inputsAreNormalized` 跳過原始 `scale/fps`。實際影像仍需做 `xfade`、音訊及其他濾鏡，final master 仍需要編碼。若存在疊化／字幕／浮水印，**不能直接改用 `-c:v copy`**。
4. `runFfmpegWithProgress` 的 `estimatedRemainingMs` 是 **該 FFmpeg 進程／階段**的 `(target out_time - actual out_time)/smoothed speed`；分段／base master 之後可能還有其他階段。以前 UI 統一顯示「預估剩餘」，容易被誤解為整個工作的剩餘時間。
5. QSV/NVENC 編碼成功不能保證 CPU filters 也由 GPU 執行。歷史實機文件 `docs/adr/0060-runtime-probed-render-pipeline.md` 記錄 QSV 可用、特定 NVIDIA 驅動與 FFmpeg NVENC API 不相容，**不可套用到未知使用者設備**。

## 這次已做的程式修正

- `src/main/services/render-estimate.ts`：
  - 最終合成複雜度改以 **最後 reduction 層的實際輸入數**計算；
  - 最終讀取中繼影片時不重複施加原始 HEVC／AV1、4K、高 FPS 的來源解碼係數；
  - 中繼處理時間拆成 Leaf 原始來源工作與後續已正規化工作，來源解碼係數只計一次。
- `src/renderer/components/ConcatRenderModal.tsx`：
  - 即時 `estimatedRemainingMs` 改標示「目前 FFmpeg 階段預估剩餘」；
  - 大型 LOW_DISK 時間線若平衡模式理論值明顯較短，顯示「長影片效能提示」，**由使用者明確點擊**切換 BALANCED 並重新執行預檢；在資源預估 DANGER 或無法轉檔時禁用。
- `tests/render-estimate.test.ts`：80／120 段 4K 60 fps 模擬時間線的回歸，確保分層增加成本，但最終 master 不再以原始片段總數膨脹。
- `tests/renderer/concat-render-modal.test.tsx`：驗證顯示標籤與切換是明確選擇，不會自行覆寫先前設定。

## 為何這輪沒有直接修改高風險轉檔演算法

FFmpeg 官方 [FAQ](https://www.ffmpeg.org/faq.html) 與 [命令文件](https://www.ffmpeg.org/ffmpeg.html) 區分 `concat` demuxer 的 stream copy 與需要 filtergraph／重新編碼的處理；使用本系統預設交叉疊化、變速／構圖／字幕／混音時，強行 stream copy 不保證畫面、聲音及時間軸等價。

沒有使用者電腦的真實 `speed=x`、CPU/GPU 及來源片段資料，也沒有長片 A/B 產出品質驗證，目前**不能保證平衡／高速模式一定比 LOW_DISK 快多少，更不能宣稱 20 小時已縮至某個確切時數**。本輪並未更改 FFmpeg 輸出指令、codec、畫質、音訊混合或 checkpoint 格式。

## 後續實機效能驗收

1. 使用相同來源、轉場、4K 或 1080p 解析度、相同 codec、相同聲音設定，在獨立 TEMP 上測試 LOW_DISK 與 BALANCED；若硬體啟動 probe 通過，再測 HIGH_SPEED。
2. 優先量測 `speed=x`、FFmpeg FPS、CPU／GPU Decode／Encode、Committed RAM、SSD IO、並行工作數、每層中繼實耗時；不要只比較事前 ETA。
3. 保持來源唯讀，產出要核對時長、影片串接、字幕、顏色／聲音、frame accuracy、音訊同步與完整 checkpoint resume。
4. 先做代表性 30–60 秒來源樣本，再測實際長片，區分冷啟動與大量素材下的 throughput。
5. 若要再減少中繼編碼層數，需有 FFmpeg 實測與時間軸等價證據，不能為速度直接更動每組輸入數或取消續轉保護。

**證據範圍：** 程式碼靜態審查、歷史倉庫紀錄、官方 FFmpeg 文件及 CI 功能測試。真實使用者的「20 小時」原因仍需本機 telemetry 才能歸因。
