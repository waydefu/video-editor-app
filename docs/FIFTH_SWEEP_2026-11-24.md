# 第五輪可靠性優化

基準：main b954a38。所有變更走獨立 PR，不修改來源媒體、現有 checkpoint 或使用者的正式成品。

## 本次變更

- Main render admission 在非同步預檢前取得；開始與續轉（含遠端）共用，專案切換拒絕進行中的准入。輸出 token 綁定專案，切換撤銷遠端準備及舊 token。刪除續轉與 master 操作加入同一准入。
- 遠端取消確認綁定工作世代；SSE 在推送及心跳檢查會話期限；遠端 ETA 標示目前階段。HTTP LAN 明確告知風險，未宣稱 TLS 已實作。
- AI / YouTube 設定先保存可復原的 schema 1 加密憑證交易 journal，檔案內容 flush 後原子發布；舊格式雙檔副本如有錯誤，由 journal 重放。未提交前還原記憶體狀態；不在此版改動舊格式。
- CI / release 先執行靜態檢查及 build，再安裝 FFmpeg；兩組 CI 獨立執行，外部下載延長退避，release 同步驗證 PATH 版本。仍依賴 Chocolatey，尚未建立獨立 checksum-pinned 鏡像及快取。
- 新增准入、journal 重放、遠端舊工作取消 nonce 回歸測試。

## 尚未結案

- Issue #2 的獨立字幕工作區三檔交易、Windows 斷電及目錄 metadata durability 測試仍待完成。Journal 的檔案 flush 不等於 Windows 完整電源故障保證；不得關閉 Issue #2。
- TEMP 搬移與所有非轉檔工作尚未統一納入完整工作排程；需要逐功能故障注入。
- HTTPS / 網路信任、正式 Windows EXE 封裝、DPI 截圖、長片 FFmpeg 性能及大型模組拆分需分開驗收。
- 本 PR 需以 Windows CI 實際結果為準，不將靜態審查當作測試通過。
