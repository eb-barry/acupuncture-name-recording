// audio-recorder.js
// 實作「方案 B」：從使用者一進入某個穴位的錄音畫面開始，就用 Web Audio API
// 連續擷取原始 PCM 資料到記憶體緩衝區裡，不中斷；每次按 Enter 只是記錄一個
// 「切割點」，再把上一個切割點到這次之間的音訊切出來，做首尾靜音裁切，
// 最後用 lamejs 編碼成 MP3。
//
// 注意：緩衝區的生命週期是「一條經脈的錄音 session」，不是整個 App 生命週期，
// 避免長時間累積導致記憶體用量過大。切換到新的經脈或關閉頁面時務必呼叫 reset()。
//
// 使用 ScriptProcessorNode（已標示為 deprecated，但目前仍被 Chrome 完整支援，
// 本專案明確以 Chrome 為目標瀏覽器，選擇它是為了實作簡單；未來若要換成
// AudioWorklet，只需要替換 CaptureEngine 內部實作，對外介面不用變）。

// audio-recorder.js
// 「方案 B」：從使用者一進入某個穴位的錄音畫面開始，就用 Web Audio API 連續擷取原始 PCM
// 資料到記憶體緩衝區裡，不中斷；每次按 Enter 只是記錄一個「切割點」，把上一個切割點到這次
// 之間的音訊切出來，直接存成 WAV 母帶（不在這裡做裁切/正規化/降噪——這些留給「音訊優化」
// 批次功能，用完整、未經處理過的原始音訊來做，效果比較好、也比較安全）。
//
// 注意：緩衝區的生命週期是「一條經脈的錄音 session」，不是整個 App 生命週期，
// 避免長時間累積導致記憶體用量過大。切換到新的經脈或關閉頁面時務必呼叫 reset()。
//
// 擷取音訊用 AudioWorkletNode（跑在獨立的「音訊執行緒」），取代舊版的 ScriptProcessorNode
// （官方已標示 deprecated，且跑在主執行緒上，主執行緒忙的時候容易漏格產生爆音）。
//
// 取樣率固定用 48000Hz：這不只是網頁播放的常見取樣率，更重要的是「音訊優化」批次功能用的
// RNNoise 降噪模型原生就是在 48kHz 下訓練的，統一用 48kHz 錄音可以完全避開重新取樣的損耗。

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

export class ContinuousRecorder {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.stream = null;
    this.leftChunks = [];
    this.rightChunks = [];
    this.totalSamples = 0;
    this.cutAtSample = 0;
    this.running = false;
    this.onLevel = null; // 由外部（app.js）設定，用來即時顯示 READY/RECORDING 燈號
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: CHANNELS,
        sampleRate: SAMPLE_RATE,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.audioContext.audioWorklet.addModule('./js/worklet/capture-processor.js');

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
    });

    this.workletNode.port.onmessage = (event) => {
      if (!this.running) return;
      const { left, right } = event.data;
      this.leftChunks.push(left);
      this.rightChunks.push(right);
      this.totalSamples += left.length;

      if (typeof this.onLevel === 'function') {
        let peak = 0;
        for (let i = 0; i < left.length; i++) {
          const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
          if (v > peak) peak = v;
        }
        this.onLevel(peak);
      }
    };

    this.sourceNode.connect(this.workletNode);
    // AudioWorkletNode 必須接到 destination 才會持續被拉動處理（即使不想真的播放出來），
    // 所以接一個靜音的 GainNode，避免使用者聽到自己講話的回音。
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    this.workletNode.connect(silentGain);
    silentGain.connect(this.audioContext.destination);

    this.running = true;
  }

  // 停止擷取（但保留已經錄到的緩衝區，方便最後一段還沒存檔前不會遺失）
  pause() {
    this.running = false;
  }

  resumeCapture() {
    this.running = true;
  }

  // 切出「上一個切割點」到「現在」之間的音訊，回傳 { left, right }，並把切割點往前推進
  cutSegment() {
    const startSample = this.cutAtSample;
    const endSample = this.totalSamples;
    const left = concatFrom(this.leftChunks, startSample, endSample);
    const right = concatFrom(this.rightChunks, startSample, endSample);
    this.cutAtSample = endSample;
    return { left, right };
  }

  // 完全停止並釋放麥克風、AudioContext，清空緩衝區
  async reset() {
    this.running = false;
    if (this.workletNode) {
      this.workletNode.port.postMessage('stop');
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.audioContext) await this.audioContext.close().catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.stream = null;
    this.leftChunks = [];
    this.rightChunks = [];
    this.totalSamples = 0;
    this.cutAtSample = 0;
  }
}

// 把多個 chunk 串成一段，只取 [startSample, endSample) 這個區間
function concatFrom(chunks, startSample, endSample) {
  const totalLength = endSample - startSample;
  if (totalLength <= 0) return new Float32Array(0);
  const result = new Float32Array(totalLength);
  let chunkStart = 0;
  let writeOffset = 0;
  for (const chunk of chunks) {
    const chunkEnd = chunkStart + chunk.length;
    const from = Math.max(startSample, chunkStart);
    const to = Math.min(endSample, chunkEnd);
    if (from < to) {
      result.set(chunk.subarray(from - chunkStart, to - chunkStart), writeOffset);
      writeOffset += to - from;
    }
    chunkStart = chunkEnd;
    if (chunkStart >= endSample) break;
  }
  return result;
}

// 首尾靜音裁切：找出振幅第一次/最後一次超過閾值的位置，前後各保留一小段緩衝(padding)，
// 避免把講話開頭的氣音或尾音切掉。
const SILENCE_THRESHOLD = 0.01; // 0~1 之間，PCM 振幅閾值。存檔前會做音量正規化把偏小聲的錄音
// 放大到接近滿格，所以這裡只需要抓「真的完全沒講話／純背景雜訊」的情況即可，不需要設太高，
// 設太高反而會把「錄得小聲但放大後其實正常」的內容誤判成沒偵測到聲音。
const PADDING_SECONDS = 0.15;

export function trimSilence(left, right, sampleRate = SAMPLE_RATE) {
  const len = left.length;
  if (len === 0) return { left, right };

  let start = 0;
  let end = len;

  while (start < len && Math.max(Math.abs(left[start]), Math.abs(right[start])) < SILENCE_THRESHOLD) {
    start++;
  }
  while (end > start && Math.max(Math.abs(left[end - 1]), Math.abs(right[end - 1])) < SILENCE_THRESHOLD) {
    end--;
  }

  // 整段都是靜音（使用者可能忘記講話）：保留原始資料，不要裁成空檔案
  if (start >= end) {
    return { left, right };
  }

  const padding = Math.floor(sampleRate * PADDING_SECONDS);
  start = Math.max(0, start - padding);
  end = Math.min(len, end + padding);

  return { left: left.subarray(start, end), right: right.subarray(start, end) };
}

// 頭尾淡入淡出（fade in / fade out）：錄音是在按 Enter 的瞬間被硬切開的，切點的振幅通常不是剛好
// 等於 0，聲音撥放時會從無到有（或從有到無）瞬間跳一個電壓差，聽起來就像「喀」一聲的爆裂音。
// 在頭尾各加一小段（預設 8 毫秒）平滑的淡入淡出，就能消除這個聲音。8 毫秒遠短於任何一個字的發音
// 時間，加上 trimSilence 本來就在頭尾各保留了 150 毫秒的緩衝，所以不會裁到真正的語音內容。
const FADE_SECONDS = 0.008;

export function applyFadeInOut(left, right, sampleRate = SAMPLE_RATE, fadeSeconds = FADE_SECONDS) {
  const fadeSamples = Math.min(Math.floor(sampleRate * fadeSeconds), Math.floor(left.length / 2));
  if (fadeSamples <= 0) return { left, right };

  const outLeft = Float32Array.from(left);
  const outRight = Float32Array.from(right);
  for (let i = 0; i < fadeSamples; i++) {
    const gain = i / fadeSamples;
    outLeft[i] *= gain;
    outRight[i] *= gain;
    const j = outLeft.length - 1 - i;
    outLeft[j] *= gain;
    outRight[j] *= gain;
  }
  return { left: outLeft, right: outRight };
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// 音量標準化（peak normalization）：把這一段錄音的音量放大到接近最大，但不失真（不 clipping）。
// 作法：找出這一段裡振幅最大的樣本，算出要放大幾倍才會讓它剛好到 targetPeak（預設 0.9，保留約
// 10% 的餘裕，避免聽起來太滿、或偶爾出現的短暫尖峰導致整段被放大不足），然後把所有樣本乘上這個
// 倍數。如果原本已經很大聲（比 targetPeak 還大），就不做任何處理，避免反而縮小音量。
const TARGET_PEAK = 0.9;

export function normalizeVolume(left, right, targetPeak = TARGET_PEAK) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (v > peak) peak = v;
  }
  if (peak === 0 || peak >= targetPeak) {
    return { left, right };
  }
  const gain = targetPeak / peak;
  const outLeft = new Float32Array(left.length);
  const outRight = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) {
    outLeft[i] = left[i] * gain;
    outRight[i] = right[i] * gain;
  }
  return { left: outLeft, right: outRight };
}

// 用 lamejs（已在頁面上以 <script> 載入為全域變數 lamejs）把立體聲 Float32 PCM 編碼成 MP3
export function encodeMp3(left, right, sampleRate = SAMPLE_RATE, kbps = 128) {
  const encoder = new lamejs.Mp3Encoder(CHANNELS, sampleRate, kbps);
  const leftInt16 = floatTo16BitPCM(left);
  const rightInt16 = floatTo16BitPCM(right);
  const blockSize = 1152;
  const mp3Chunks = [];

  for (let i = 0; i < leftInt16.length; i += blockSize) {
    const leftChunk = leftInt16.subarray(i, i + blockSize);
    const rightChunk = rightInt16.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
    if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
  }
  const finalBuf = encoder.flush();
  if (finalBuf.length > 0) mp3Chunks.push(finalBuf);

  return new Blob(mp3Chunks, { type: 'audio/mp3' });
}

export function hasSpeech(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (Math.max(Math.abs(left[i]), Math.abs(right[i])) >= SILENCE_THRESHOLD) return true;
  }
  return false;
}

// 把立體聲 Float32 PCM 編碼成標準的 16-bit PCM WAV（無壓縮），用來存錄音母帶。
// WAV 只是加個檔頭、資料本身不需要任何壓縮運算，所以存檔當下的負擔比 MP3 編碼輕很多。
export function encodeWav(left, right, sampleRate = SAMPLE_RATE) {
  const leftInt16 = floatTo16BitPCM(left);
  const rightInt16 = floatTo16BitPCM(right);
  const numFrames = leftInt16.length;
  const bytesPerSample = 2;
  const blockAlign = CHANNELS * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    view.setInt16(offset, leftInt16[i], true);
    offset += 2;
    view.setInt16(offset, rightInt16[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
