// sync.js
// 掃描所選資料夾裡 raw_wav/ 的 WAV 母帶，算出「每條經脈實際有哪些穴位（以及總穴數口播）已經錄好」。
// 每次啟動程式、重新確認資料夾權限、開始錄音前、回到首頁時都會重新掃描，
// 所以使用者手動刪除或補進檔案，進度都會跟著實際情況更新。
//
// 純函式：meridians（Map<經脈名, 穴位陣列>）與 getResetAt 都由呼叫端傳入，方便在 Node 測試。

import { buildWavFileName, buildIntroWavFileName, INTRO_CODE } from './points-data.js';

export const RAW_WAV_DIR = 'raw_wav';

// 回傳 { doneByMeridian, stats }
//   doneByMeridian: { [經脈名]: [code, ...] }（口播以 INTRO_CODE 表示）
//   stats: { wavFiles, legacyMp3, rawDirMissing }
export async function scanRecordedFiles(rootHandle, meridians, getResetAt = () => 0) {
  const wavHandles = new Map(); // 檔名 → FileHandle
  let legacyMp3 = 0;
  let rawDirMissing = false;

  // 舊版（改存 WAV 之前）直接把 MP3 存在根目錄；這些不含 WAV 母帶，無法做音訊優化，只計數提醒使用者。
  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind === 'file' && name.toLowerCase().endsWith('.mp3')) legacyMp3++;
  }

  try {
    const rawDir = await rootHandle.getDirectoryHandle(RAW_WAV_DIR);
    for await (const [name, handle] of rawDir.entries()) {
      if (handle.kind === 'file' && name.toLowerCase().endsWith('.wav')) wavHandles.set(name, handle);
    }
  } catch (e) {
    if (e && e.name === 'NotFoundError') rawDirMissing = true; // 還沒錄過任何東西：全部視為未完成
    else throw e;
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

  return { doneByMeridian, stats: { wavFiles: wavHandles.size, legacyMp3, rawDirMissing } };
}
