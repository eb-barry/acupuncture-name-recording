# acupuncture-name-recording 中醫穴位錄音系統

record the name of acupuncture for various of vocal characters — the audio files will be used by the 針灸助理 (acupuncture assistant) application.

一個純前端（HTML + JavaScript）的錄音工具，用來把十四經脈穴位名稱逐一錄成獨立的 MP3 檔案。

## 使用方式（目前僅支援桌面版 Chrome / Edge）

1. 用 Chrome 或 Edge 開啟 <https://eb-barry.github.io/acupuncture-name-recording/>
2. 選擇「逐穴錄音」或「單穴錄音」模式
   - **逐穴錄音**：選一條經脈，依國際標準碼順序（如 LU1 → LU11）逐穴錄製
   - **單穴錄音**：選定經脈與單一穴位，單獨錄製 / 重錄
3. 第一次按「開始錄音」時，瀏覽器會請你：
   - 授權麥克風
   - 選擇一個資料夾，之後所有 MP3 都會直接存進這個資料夾
4. 畫面顯示目前要錄的穴位名稱與進度。看到綠燈 READY 就可以直接開口唸出穴位名稱，錄音其實已經在背景持續進行；講完按 **Enter**，系統會自動裁掉頭尾的靜音、存成 MP3，並自動換下一穴
5. 錄音進度會保存在瀏覽器的 localStorage，中途離開再回來可以接續上次的進度（重新整理頁面後，瀏覽器可能需要你重新確認一次資料夾權限）

### 檔名規範

```
[國際代碼]-[經脈名稱]-[穴位名稱].mp3
```

例如：`LU1-手太陰肺經-中府.mp3`、`LU2-手太陰肺經-雲門.mp3`

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
