// zhuyin.js
// 把穴位名稱／口播文字轉成「畫面顯示用」的字串：在特定字的後面插入一個
// 看不見的 IVS（異體字選擇符），套用 ZhuyinAcupoint 字型時就會換成正確的讀音字形。
//
// OVERRIDES 這份清單，是核對過「多音字讀音對照表.xlsx」（362 個穴位、189 個多音字）
// 之後，唯一需要從字型預設讀音改成第二個讀音的 9 個字。字型裡每個字最多可以有到
// 第 7 個讀音變體，但目前核對結果只用到「索引 1」，所以這裡固定插入 U+E01E1；
// 如果之後又發現需要別的索引，在這裡加一筆 { char: 索引 } 就好，不用改字型檔。
//
// 字型本身沒有的字（目前只有「譩」，BL45 譩譆）不會出現在這份清單裡：
// CSS 的 font-family fallback 會自動讓瀏覽器對那一個字改用系統字型顯示（不會有注音）。

const VARIANT_SELECTOR_BASE = 0xE01E0; // 索引 0 = 無註記版本（本專案沒用到），索引 1 起才是各種讀音

export const OVERRIDES = {
  少: 1, // ST36 等穴位用「ㄕㄠˋ」而非字型預設的「ㄕㄠˇ」
  率: 1, // 率谷 GB8
  瘈: 1, // 瘈脈 TE18
  突: 1, // 天突/扶突/水突等
  膀: 1, // 膀胱俞 BL28
  膻: 1, // 膻中 CV17
  都: 1, // 陰都/蠡溝旁的中都等
  處: 1, // 五處 BL5
  髃: 1, // 肩髃 LI15
};

function selectorFor(index) {
  return String.fromCodePoint(VARIANT_SELECTOR_BASE + index);
}

// 把一般文字轉成套用注音字型時會正確顯示讀音的字串
export function withZhuyin(text) {
  let out = '';
  for (const ch of text) {
    out += ch;
    const idx = OVERRIDES[ch];
    if (idx) out += selectorFor(idx);
  }
  return out;
}
