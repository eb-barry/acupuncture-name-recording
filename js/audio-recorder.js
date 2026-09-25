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

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BUFFER_SIZE = 4096;

export class ContinuousRecorder {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
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
        autoGainControl: false,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    // 有些裝置的麥克風只有單聲道；createScriptProcessor 的輸入聲道數要跟來源一致，
    // 所以用來源的實際聲道數，輸出時再視需要補成立體聲。
    const inputChannels = this.sourceNode.channelCount || 1;
    this.processorNode = this.audioContext.createScriptProcessor(BUFFER_SIZE, inputChannels, CHANNELS);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.running) return;
      const input = event.inputBuffer;
      const left = new Float32Array(input.getChannelData(0));
      const right = input.numberOfChannels > 1 ? new Float32Array(input.getChannelData(1)) : new Float32Array(left);
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

    this.sourceNode.connect(this.processorNode);
    // ScriptProcessorNode 必須接到 destination 才會觸發 onaudioprocess（即使不想真的播放出來），
    // 所以接一個靜音的 GainNode，避免使用者聽到自己講話的回音。
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    this.processorNode.connect(silentGain);
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
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
    }
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.audioContext) await this.audioContext.close().catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
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
const SILENCE_THRESHOLD = 0.02; // 0~1 之間，PCM 振幅閾值，可視情況調整
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

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
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
