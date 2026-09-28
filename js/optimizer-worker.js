// optimizer-worker.js
// 在 Web Worker 裡跑降噪與音訊處理，原因有兩個：
//   1. Chrome 不允許在「主執行緒」同步編譯大於 4KB 的 WebAssembly，RNNoise 的 sync 版本只能在
//      Worker / AudioWorklet 裡載入。
//   2. 批次處理幾百個檔案時，運算不會卡住主畫面，進度條與取消按鈕可以正常運作。
//
// 訊息協定：
//   worker → main  { type: 'ready' }                         模型載入完成
//   worker → main  { type: 'init-error', message }           模型載入失敗
//   main → worker  { type: 'process', id, buffer }           處理一個 WAV（buffer 以 transfer 傳入）
//   worker → main  { type: 'result', id, report, left, right, error? }
//   main → worker  { type: 'dispose' }

import createModule from '../vendor/rnnoise-sync.js';
import { createDenoiser, optimizeAudio } from './optimizer-core.js';

let denoiser = null;
try {
  denoiser = createDenoiser(createModule);
  self.postMessage({ type: 'ready' });
} catch (e) {
  self.postMessage({ type: 'init-error', message: e && e.message ? e.message : String(e) });
}

self.onmessage = (event) => {
  const { type, id, buffer } = event.data || {};

  if (type === 'process') {
    try {
      const r = optimizeAudio(buffer, denoiser);
      const transfer = r.left ? [r.left.buffer, r.right.buffer] : [];
      self.postMessage({ type: 'result', id, report: r.report, left: r.left, right: r.right }, transfer);
    } catch (e) {
      self.postMessage({ type: 'result', id, error: e && e.message ? e.message : String(e) });
    }
  } else if (type === 'dispose') {
    if (denoiser) denoiser.destroy();
    self.close();
  }
};
