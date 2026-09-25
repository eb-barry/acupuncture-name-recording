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

// ---- 錄音進度（localStorage） ----
// 結構：{ [meridianName]: { done: [code1, code2, ...], updatedAt: number } }
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

export function markPointDone(meridianName, code) {
  const data = readProgress();
  if (!data[meridianName]) data[meridianName] = { done: [] };
  if (!data[meridianName].done.includes(code)) {
    data[meridianName].done.push(code);
  }
  data[meridianName].updatedAt = Date.now();
  writeProgress(data);
}

export function resetMeridianProgress(meridianName) {
  const data = readProgress();
  delete data[meridianName];
  writeProgress(data);
}

export function isPointDone(meridianName, code) {
  const data = readProgress();
  return !!(data[meridianName] && data[meridianName].done.includes(code));
}
