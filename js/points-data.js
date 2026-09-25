// points-data.js
// 讀取 data/points-data.json（跟「針灸助理」共用的原始資料，格式為
// { 穴位中文名: { 所屬經脈, 國際代碼, ... } } 的攤平物件），
// 依「所屬經脈」分組，並依「國際代碼」裡的數字部分做正確的數值排序
// （例如 LU2 要排在 LU10 前面，不能用字串排序）。

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

  cache = byMeridian;
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
