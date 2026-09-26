// points-data.js
// 讀取 data/points-data.json（跟「針灸助理」共用的原始資料，格式為
// { 穴位中文名: { 所屬經脈, 國際代碼, ... } } 的攤平物件），
// 依「所屬經脈」分組，並依「國際代碼」裡的數字部分做正確的數值排序
// （例如 LU2 要排在 LU10 前面，不能用字串排序）。

// 經脈列表的顯示順序：依十二經脈流注順序 + 任脈 + 督脈。
// data/points-data.json 裡的物件屬性順序是不固定的（依原始資料建立時的先後），
// 所以經脈下拉選單需要自己指定順序，不能直接用物件 key 出現的順序。
const MERIDIAN_ORDER = [
  '手太陰肺經',
  '手陽明大腸經',
  '足陽明胃經',
  '足太陰脾經',
  '手少陰心經',
  '手太陽小腸經',
  '足太陽膀胱經',
  '足少陰腎經',
  '手厥陰心包經',
  '手少陽三焦經',
  '足少陽膽經',
  '足厥陰肝經',
  '任脈',
  '督脈',
];

let cache = null;

export async function loadPointsIndex() {
  if (cache) return cache;

  const res = await fetch('./data/points-data.json');
  if (!res.ok) throw new Error('無法載入 points-data.json');
  const raw = await res.json();

  const byMeridian = new Map();
  const codePattern = /^([A-Za-z-]+)(\d+)$/;

  for (const [pointName, info] of Object.entries(raw)) {
    const code = info['國際代碼'];
    const meridian = info['所屬經脈'];
    if (!code || !meridian) continue;

    const match = codePattern.exec(code);
    const order = match ? parseInt(match[2], 10) : Number.MAX_SAFE_INTEGER;

    if (!byMeridian.has(meridian)) byMeridian.set(meridian, []);
    byMeridian.get(meridian).push({ name: pointName, code, order });
  }

  for (const points of byMeridian.values()) {
    points.sort((a, b) => a.order - b.order);
  }

  // 依 MERIDIAN_ORDER 重新排列 Map 的 key 順序；不在清單裡的經脈（例如「經外」奇穴）
  // 放在最後面，順序依原始資料出現的先後。
  const orderedNames = [
    ...MERIDIAN_ORDER.filter((name) => byMeridian.has(name)),
    ...Array.from(byMeridian.keys()).filter((name) => !MERIDIAN_ORDER.includes(name)),
  ];
  const ordered = new Map();
  for (const name of orderedNames) {
    ordered.set(name, byMeridian.get(name));
  }

  cache = ordered;
  return cache;
}

export async function getMeridianNames() {
  const index = await loadPointsIndex();
  return Array.from(index.keys());
}

export async function getPointsForMeridian(meridianName) {
  const index = await loadPointsIndex();
  return index.get(meridianName) || [];
}

// 檔名規範：[國際代碼]-[經脈名稱]-[穴位名稱].mp3
export function buildFileName(meridianName, point) {
  return `${point.code}-${meridianName}-${point.name}.mp3`;
}
