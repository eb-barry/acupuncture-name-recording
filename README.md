# acupuncture-name-recording 中醫穴位錄音系統

record the name of acupuncture for various of vocal characters — the audio files will be used by the 針灸助理 (acupuncture assistant) application.

一個純前端（HTML + JavaScript）的錄音工具，用來把十四經脈穴位名稱逐一錄成獨立的 MP3 檔案。

## 使用方式（目前僅支援桌面版 Chrome / Edge）

1. 用 Chrome 或 Edge 開啟 <https://eb-barry.github.io/acupuncture-name-recording/>
2. 選擇「逐經脈錄音」或「單穴錄音」模式
   - **逐經脈錄音**：選一條經脈，先錄一段「經脈名稱共 N 穴」的口播，再依國際標準碼順序（如 LU1 → LU11）逐穴錄製
   - **單穴錄音**：選定經脈與單一穴位，單獨錄製 / 重錄
3. 第一次按「開始錄音」時，瀏覽器會請你：
   - 授權麥克風
   - 選擇一個資料夾，之後錄音會以 WAV 母帶格式存進裡面的 `raw_wav/` 子資料夾（不壓縮、不做任何處理，永久保留原始素材）
4. 畫面顯示目前要錄的穴位名稱與進度。看到綠燈 READY 就可以直接開口唸出穴位名稱，錄音其實已經在背景持續進行；講完按 **Enter**，系統會把這一段存成 WAV 母帶，並自動換下一穴
5. 錄音進度會保存在瀏覽器的 localStorage，中途離開再回來可以接續上次的進度（重新整理頁面後，瀏覽器可能需要你重新確認一次資料夾權限）

### 錄音進度與資料夾同步

進度以資料夾裡**實際存在的 `raw_wav/*.wav`** 為準。每次啟動、回到首頁、開始錄音前都會掃描一次，所以：

- 手動刪除某個穴位的 WAV → 該穴位變回「未錄」，經脈清單的 ✅ 也會消失；逐經脈錄音只會從缺的穴位補錄，已經存在的不會重錄
- 手動放回檔案 → 自動算成已完成
- 「重錄整條經脈」不會刪除舊檔案，而是記下重錄時間點：修改時間早於這個時間點的舊檔不算已完成，重新啟動也不會被舊檔蓋回去
- 舊版直接存成 MP3 的檔案沒有 WAV 母帶，不列入進度（頁面上會提示數量）
- 瀏覽器重新啟動後，資料夾權限可能需要重新確認：此時先顯示上次記錄的進度，按首頁「重新掃描資料夾」確認權限後就會同步。Chrome 跳出權限提示時若選「每次造訪時都允許」，之後啟動就會自動同步

### 音訊優化（全部錄完後）

首頁第三個功能「音訊優化」會批次處理 `raw_wav/` 裡所有的 WAV 母帶：

1. **降噪**：RNNoise（與 Jitsi Meet 相同的開源語音降噪模型，WebAssembly，在 Web Worker 裡執行）
2. **裁切**：在「降噪後」的訊號上找出真正的語音起訖點，剪掉前後空白，前後各補上 0.5 秒**真正的數位靜音**（振幅為 0）
3. **音量**：只依語音區段的峰值正規化到 90%（不會把雜訊一起放大）
4. **輸出**：只做一次 MP3 編碼（48kHz 立體聲 128kbps），存到 `certified_recording/`，檔名同錄音、副檔名 `.mp3`
5. **品質報告**：`certified_recording/optimization_report.csv`，列出每個檔案降噪前後的訊噪比與需要人工檢查（可能要重錄）的原因

WAV 母帶不會被修改，所以可以重複執行。

### 檔名規範

```
[國際代碼]-[經脈名稱]-[穴位名稱].mp3
```

例如：`LU1-手太陰肺經-中府`、`LU2-手太陰肺經-雲門`；經脈總穴數口播為 `LU-11`。錄音時存成 `raw_wav/*.wav`，音訊優化後輸出 `certified_recording/*.mp3`。

## 技術重點

- 錄音：`Web Audio API`（`ScriptProcessorNode` 連續擷取 PCM，按 Enter 只是標記切割點，不中斷錄音）
- 靜音裁切：依振幅閾值裁掉每段錄音開頭與結尾的靜音
- MP3 編碼：[lamejs](https://github.com/zhuker/lamejs)（已 vendor 進 `vendor/lame.min.js`，離線也能用）
- 存檔：File System Access API，一次選定資料夾即可連續寫檔，不會每個穴位都跳一次下載視窗
- 穴位資料：`data/points-data.json`，跟「針灸助理」App 共用同一份原始資料
- 可安裝為 PWA，離線可用（`manifest.json` + `sw.js`）

## 已知限制

- File System Access API 目前只有 Chromium 系瀏覽器（Chrome / Edge）支援，Safari / Firefox 無法使用存檔功能
- 瀏覽器基於安全機制，重新整理頁面後資料夾的寫入權限不會自動延續，需要使用者手動點一下重新確認
