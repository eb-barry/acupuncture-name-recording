# 穴位注音字型（子集版）授權說明

網站裡穴位名稱大字顯示用的注音字型，是從以下字型子集化而來：

- **原始字型**：ToneOZ-Zhuyin-Tsuipita-TC
- **版權**：Copyright 2024 ToneOZ (https://toneoz.com)　Copyright 2022 cjkFonts
- **商標**：ToneOZ 是 Australian Company Tone A To Z 的商標
- **授權**：SIL Open Font License, Version 1.1（全文見 `OFL-1.1.txt`）
- **來源**：字型檔內嵌的 name table 授權欄位（本專案開發時直接讀取確認）

## 子集化說明

`vendor/zhuyin-subset.woff2` 只保留了本站十四經脈 362 個穴位名稱、經脈名稱會用到的
337 個中文字，以及少數字（少、率、瘈、突、膀、膻、都、處、髃）的第二種讀音變體
（IVS 選擇符 U+E01E1），用 `pyftsubset` 子集化並轉成 WOFF2。原始字型檔約 32MB，
子集後約 300KB。

依照 OFL 1.1 的規定，衍生（子集化）版本不沿用原字型名稱，CSS 裡的
`font-family` 使用自訂名稱 `ZhuyinAcupoint`，不是 `ToneOZ-Zhuyin-Tsuipita-TC`。

## 已知限制

「譩」這個字（出現在 BL45 譩譆）原始字型裡就沒有這個字的字形，子集化後畫面上
會自動改用系統字型顯示，不會帶注音。讀音依核對結果為同「意」（ㄧˋ）。
