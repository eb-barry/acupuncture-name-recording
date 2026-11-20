// listen.js
// 「經穴試聽」：讀取使用者所選資料夾，或其 certified_recording/ 子資料夾中的 MP3。
// 跟錄音、優化都不一樣的地方：這裡完全不寫檔，只讀取，所以不需要處理任何覆蓋/備份的問題。

import { buildFileName, buildIntroFileName, buildIntroText, INTRO_CODE } from './points-data.js';
import { CERTIFIED_DIR } from './optimizer.js';

// 建立一條經脈的播放清單：口播（如果有）+ 依 WHO 國際代碼順序排列的每個穴位。
// 回傳 [{ code, label, fileName, exists }]，exists=false 的項目在播放時會被跳過並標記缺檔。
export async function buildMeridianPlaylist(certifiedDir, meridianName, points) {
  const list = [];

  const introName = buildIntroFileName(meridianName, points);
  list.push({
    code: INTRO_CODE,
    label: buildIntroText(meridianName, points),
    fileName: introName,
    exists: await fileExists(certifiedDir, introName),
  });

  for (const point of points) {
    const fileName = buildFileName(meridianName, point);
    list.push({
      code: point.code,
      label: point.name,
      fileName,
      exists: await fileExists(certifiedDir, fileName),
    });
  }
  return list;
}

export async function buildSinglePlaylist(certifiedDir, meridianName, point) {
  const fileName = buildFileName(meridianName, point);
  return [{
    code: point.code,
    label: point.name,
    fileName,
    exists: await fileExists(certifiedDir, fileName),
  }];
}

export async function buildIntroPlaylist(certifiedDir, meridianName, points) {
  const fileName = buildIntroFileName(meridianName, points);
  return [{
    code: INTRO_CODE,
    label: buildIntroText(meridianName, points),
    fileName,
    exists: await fileExists(certifiedDir, fileName),
  }];
}

async function fileExists(dirHandle, fileName) {
  try {
    await dirHandle.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}

export async function getCertifiedDir(rootHandle) {
  try {
    return await rootHandle.getDirectoryHandle(CERTIFIED_DIR);
  } catch {
    return null;
  }
}

async function countMp3Files(dirHandle) {
  let count = 0;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && name.toLowerCase().endsWith('.mp3')) count++;
  }
  return count;
}

// 使用者可以選錄音專案的根資料夾，也可以直接選 certified_recording。
// 優先採用 certified_recording，避免根目錄中的舊版 MP3 蓋過優化後的成品。
export async function findListenDirectory(rootHandle) {
  const certifiedDir = await getCertifiedDir(rootHandle);
  if (certifiedDir) {
    const mp3Count = await countMp3Files(certifiedDir);
    if (mp3Count > 0) return { dirHandle: certifiedDir, mp3Count };
  }

  const mp3Count = await countMp3Files(rootHandle);
  if (mp3Count > 0) return { dirHandle: rootHandle, mp3Count };
  return null;
}

export async function loadAudioUrl(dirHandle, fileName) {
  const fileHandle = await dirHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}
