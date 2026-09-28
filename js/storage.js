// storage.js
// 負責兩件事：
// 1. 用 IndexedDB 保存使用者選擇的資料夾控制代碼 (File System Access API 的 directory handle)
// 2. 用 localStorage 記錄錄音進度（哪些穴位已經錄過），避免整條經脈重錄

const DB_NAME = 'acupuncture-recorder';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'output-directory';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirectoryHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDirectoryHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearDirectoryHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 確認資料夾權限是否還有效；沒有的話嘗試重新要求（必須由使用者點擊觸發才會跳出瀏覽器提示）
export async function verifyPermission(handle, requestIfNeeded = true) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!requestIfNeeded) return false;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

// 在使用者選定的資料夾底下，取得（不存在就建立）一個子資料夾，例如 raw_wav / certified_recording
export async function getSubDirectory(rootHandle, name) {
  return rootHandle.getDirectoryHandle(name, { create: true });
}

// ---- 錄音進度（localStorage） ----
// 結構：{ [meridianName]: { done: [code1, code2, ...], updatedAt: number, resetAt?: number } }
//
// 進度的「事實來源」是資料夾裡實際存在的 WAV 檔（每次啟動會掃描並同步，見 sync.js），
// localStorage 只是快取，讓畫面能立刻顯示、也讓沒有資料夾權限時還看得到上次的進度。
//
// resetAt：使用者按「重錄整條經脈」的時間點。重錄不會刪除硬碟上的舊檔案（舊檔會在重新錄好時被覆蓋），
// 但掃描時「修改時間早於 resetAt」的舊檔案不算已完成，這樣重新啟動後進度才不會被舊檔案又蓋回去。
const PROGRESS_KEY = 'acupuncture-recorder-progress';

function readProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('讀取進度失敗', e);
    return {};
  }
}

function writeProgress(data) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
}

export function getMeridianProgress(meridianName) {
  const data = readProgress();
  return data[meridianName] || { done: [] };
}

export function getResetAt(meridianName) {
  return getMeridianProgress(meridianName).resetAt || 0;
}

export function markPointDone(meridianName, code) {
  const data = readProgress();
  if (!data[meridianName]) data[meridianName] = { done: [] };
  if (!data[meridianName].done.includes(code)) {
    data[meridianName].done.push(code);
  }
  data[meridianName].updatedAt = Date.now();
  writeProgress(data);
}

// 「重錄整條經脈」：清空已完成清單，並記下重錄時間點（保留舊檔案，不刪除硬碟上的母帶）
export function resetMeridianProgress(meridianName) {
  const data = readProgress();
  data[meridianName] = { done: [], updatedAt: Date.now(), resetAt: Date.now() };
  writeProgress(data);
}

// 用掃描結果整批取代各經脈的已完成清單（保留各自的 resetAt）。
// doneByMeridian：{ [meridianName]: [code, ...] }
export function replaceAllProgress(doneByMeridian) {
  const data = readProgress();
  for (const [name, done] of Object.entries(doneByMeridian)) {
    const prev = data[name] || {};
    data[name] = { ...prev, done, updatedAt: Date.now() };
  }
  writeProgress(data);
}

export function isPointDone(meridianName, code) {
  const data = readProgress();
  return !!(data[meridianName] && data[meridianName].done.includes(code));
}
