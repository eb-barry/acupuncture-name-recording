// listen.js
// 「經穴試聽」：從 certified_recording/ 讀取已經做過音訊優化的成品 MP3 來播放。
// 跟錄音、優化都不一樣的地方：這裡完全不寫檔，只讀取，所以不需要處理任何覆蓋/備份的問題。

import { buildFileName, buildIntroFileName, INTRO_CODE } from './points-data.js';
import { CERTIFIED_DIR } from './optimizer.js';

// 建立一條經脈的播放清單：口播（如果有）+ 依 WHO 國際代碼順序排列的每個穴位。
// 回傳 [{ code, label, fileName, exists }]，exists=false 的項目在播放時會被跳過並標記缺檔。
export async function buildMeridianPlaylist(certifiedDir, meridianName, points) {
  const list = [];

  const introName = buildIntroFileName(meridianName, points);
  list.push({
    code: INTRO_CODE,
    label: `${meridianName}總穴數口播`,
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

export async function loadAudioUrl(dirHandle, fileName) {
  const fileHandle = await dirHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}
