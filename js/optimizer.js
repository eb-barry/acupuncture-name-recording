// optimizer.js
// 「音訊優化」批次執行器（瀏覽器端）：
//   讀取 <所選資料夾>/raw_wav/*.wav（錄音母帶，永遠不會被修改）
//   → Web Worker 內用 optimizer-core 處理（RNNoise 降噪、依降噪後訊號裁切、補 0.5 秒真靜音、正規化）
//   → lamejs 編碼成 MP3（整個流程只編碼這一次，沒有二次壓縮）
//   → 寫入 <所選資料夾>/certified_recording/ 同名 .mp3
//   → 另外輸出 optimization_report.csv，列出每個檔案的處理結果與需要人工檢查的項目
//
// 因為 WAV 母帶不會被覆蓋，這個功能可以安全地重複執行（例如之後調整了參數想重跑）。

import { encodeMp3 } from './audio-recorder.js';
import { getSubDirectory } from './storage.js';

export const RAW_WAV_DIR = 'raw_wav';
export const CERTIFIED_DIR = 'certified_recording';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0)); // 讓出主執行緒，畫面才能更新進度

// 建立 Worker 並等它把 RNNoise 模型載入完成。回傳 { process(buffer), dispose() }
function createWorkerClient() {
  const worker = new Worker(new URL('./optimizer-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  let failure = null;

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') resolve();
      else if (msg.type === 'init-error') reject(new Error(`降噪模型載入失敗：${msg.message}`));
      else if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg);
      }
    };
    worker.onerror = (event) => {
      failure = new Error(`降噪 Worker 發生錯誤：${event.message || '無法載入 optimizer-worker.js 或降噪模型'}`);
      reject(failure);
      for (const p of pending.values()) p.reject(failure);
      pending.clear();
    };
  });

  return {
    ready,
    process(buffer) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'process', id, buffer }, [buffer]);
      });
    },
    dispose() {
      try { worker.postMessage({ type: 'dispose' }); } catch { /* worker 可能已經結束 */ }
      setTimeout(() => worker.terminate(), 200);
    },
  };
}

async function listWavFiles(rawDir) {
  const files = [];
  for await (const [name, handle] of rawDir.entries()) {
    if (handle.kind === 'file' && name.toLowerCase().endsWith('.wav')) files.push({ name, handle });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return files;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const header = ['檔名', '狀態', '原始訊噪比dB', '降噪後訊噪比dB', '音量增益dB', '語音長度秒', '原始長度秒', '需要檢查的原因', '錯誤訊息'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.name, r.status,
      r.snrBefore?.toFixed(1), r.snrAfter?.toFixed(1), r.gainDb?.toFixed(1),
      r.voicedSeconds?.toFixed(2), r.originalSeconds?.toFixed(2),
      (r.flags || []).join('；'), r.error || '',
    ].map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM 讓 Excel 正確顯示中文
}

// options: { onProgress({index,total,name}), shouldCancel() }
// 回傳 { total, ok, review, failed, cancelled, rows }
export async function runOptimization(rootHandle, options = {}) {
  const { onProgress = () => {}, shouldCancel = () => false } = options;

  let rawDir;
  try {
    rawDir = await rootHandle.getDirectoryHandle(RAW_WAV_DIR);
  } catch {
    throw new Error(`找不到 ${RAW_WAV_DIR} 資料夾。請先用「逐經脈錄音／單穴錄音」錄製（新版錄音會存成 WAV 母帶）。`);
  }
  const files = await listWavFiles(rawDir);
  if (files.length === 0) throw new Error(`${RAW_WAV_DIR} 資料夾裡沒有任何 WAV 檔。`);

  const certDir = await getSubDirectory(rootHandle, CERTIFIED_DIR);

  // Worker 與 RNNoise（約 2MB）只在真的要優化時才建立，不拖慢平常錄音的啟動速度
  const client = createWorkerClient();
  await client.ready.catch((e) => { client.dispose(); throw e; });

  const rows = [];
  let cancelled = false;
  try {
    for (let i = 0; i < files.length; i++) {
      if (shouldCancel()) { cancelled = true; break; }
      const { name, handle } = files[i];
      onProgress({ index: i, total: files.length, name });
      await tick();

      const row = { name: name.replace(/\.wav$/i, '.mp3') };
      try {
        const buf = await (await handle.getFile()).arrayBuffer();
        const result = await client.process(buf);
        Object.assign(row, result.report);

        if (result.left) {
          const mp3 = encodeMp3(result.left, result.right);
          const out = await certDir.getFileHandle(row.name, { create: true });
          const writable = await out.createWritable();
          await writable.write(mp3);
          await writable.close();
        }
      } catch (e) {
        console.error(name, e);
        row.status = 'failed';
        row.error = e && e.message ? e.message : String(e);
      }
      rows.push(row);
    }
  } finally {
    client.dispose();
  }

  // 報告（即使中途取消，已處理的部分也寫出來）
  try {
    const report = await certDir.getFileHandle('optimization_report.csv', { create: true });
    const w = await report.createWritable();
    await w.write(buildCsv(rows));
    await w.close();
  } catch (e) {
    console.error('寫入報告失敗', e);
  }

  return {
    total: files.length,
    ok: rows.filter((r) => r.status === 'ok').length,
    review: rows.filter((r) => r.status === 'review' || r.status === 'no-speech'),
    failed: rows.filter((r) => r.status === 'failed'),
    cancelled,
    rows,
  };
}
