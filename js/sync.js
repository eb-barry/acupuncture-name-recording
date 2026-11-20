// sync.js
// 掃描所選資料夾裡 raw_wav/ 的 WAV 母帶，算出「每條經脈實際有哪些穴位（以及總穴數口播）已經錄好」。
// 每次啟動程式、重新確認資料夾權限、開始錄音前、回到首頁時都會重新掃描，
// 所以使用者手動刪除或補進檔案，進度都會跟著實際情況更新。
//
// 純函式：meridians（Map<經脈名, 穴位陣列>）與 getResetAt 都由呼叫端傳入，方便在 Node 測試。

import { buildWavFileName, buildIntroWavFileName, INTRO_CODE } from './points-data.js';

export const RAW_WAV_DIR = 'raw_wav';

async function countAudio(dirHandle, wavHandles) {
  let mp3Files = 0;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.wav')) {
      if (wavHandles) wavHandles.set(name, handle);
    } else if (lower.endsWith('.mp3')) {
      mp3Files++;
    }
  }
  return mp3Files;
}

// 回傳 { doneByMeridian, stats }
//   doneByMeridian: { [經脈名]: [code, ...] }（口播以 INTRO_CODE 表示）
//   stats: { wavFiles, mp3Files, legacyMp3, rawDirMissing }
export async function scanRecordedFiles(rootHandle, meridians, getResetAt = () => 0) {
  const wavHandles = new Map(); // raw_wav 檔名 → FileHandle
  let rawDirMissing = false;

  // 根目錄的 MP3 是舊版錄音；raw_wav 與 certified_recording 也要一起數，
  // 才能判斷這個資料夾是不是完全沒有音檔。
  const legacyMp3 = await countAudio(rootHandle);
  let mp3Files = legacyMp3;

  try {
    const rawDir = await rootHandle.getDirectoryHandle(RAW_WAV_DIR);
    mp3Files += await countAudio(rawDir, wavHandles);
  } catch (e) {
    if (e && e.name === 'NotFoundError') rawDirMissing = true; // 還沒錄過任何東西：全部視為未完成
    else throw e;
  }

  try {
    const certifiedDir = await rootHandle.getDirectoryHandle('certified_recording');
    mp3Files += await countAudio(certifiedDir);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') throw e;
  }

  // 有效的錄音檔：存在，且（如果這條經脈按過「重錄整條經脈」）修改時間不早於重錄時間點
  const isValid = async (fileName, resetAt) => {
    const handle = wavHandles.get(fileName);
    if (!handle) return false;
    if (!resetAt) return true;
    const file = await handle.getFile();
    return file.lastModified >= resetAt;
  };

  const doneByMeridian = {};
  for (const [meridianName, points] of meridians) {
    const resetAt = getResetAt(meridianName);
    const done = [];

    if (points.length > 0 && (await isValid(buildIntroWavFileName(meridianName, points), resetAt))) {
      done.push(INTRO_CODE);
    }
    for (const point of points) {
      if (await isValid(buildWavFileName(meridianName, point), resetAt)) done.push(point.code);
    }
    doneByMeridian[meridianName] = done;
  }

  return { doneByMeridian, stats: { wavFiles: wavHandles.size, mp3Files, legacyMp3, rawDirMissing } };
}
