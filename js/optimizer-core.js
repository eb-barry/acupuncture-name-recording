// optimizer-core.js
// 「音訊優化」的核心處理邏輯，全部是純函式、不碰 DOM，所以瀏覽器跟 Node 測試都能用。
//
// 單一檔案處理流程（輸入是錄音當下存的 WAV 母帶）：
//   1. 解析 WAV → Float32 立體聲
//   2. RNNoise 降噪（左右聲道各自獨立處理）
//   3. 在「降噪後」的訊號上找出真正的語音起訖點（降噪前雜訊太大，音量門檻分不出來）
//   4. 只取出語音區段（前後各留一小段緩衝避免吃掉氣音/尾音），頭尾套淡入淡出
//   5. 前後各補上「憑空生成」的 0.5 秒真數位靜音（振幅完全為 0，不是「洗乾淨的雜訊」）
//   6. 音量正規化（只用語音區段的峰值計算，所以不會把雜訊一起放大）
//   7. 回傳品質報告（降噪前後訊噪比等），讓使用者知道哪些檔案需要重錄

export const SAMPLE_RATE = 48000; // RNNoise 原生取樣率，錄音也統一用 48kHz
export const RNNOISE_FRAME = 480; // RNNoise 固定每次處理 480 個樣本（10 毫秒 @48kHz）
export const SILENCE_PAD_SECONDS = 0.1; // 語音前後各補的真靜音長度
export const TARGET_PEAK = 0.9;

const GUARD_SECONDS = 0.06; // 語音起訖點外多保留的緩衝，避免吃掉氣音/尾音
const EDGE_FADE_SECONDS = 0.01; // 語音區段頭尾淡入淡出長度
const ANALYSIS_FRAME = 480; // 能量分析的視窗（10 毫秒）
const WARMUP_FRAMES = 50; // RNNoise 暖機用的開頭長度（50 × 10ms = 0.5 秒）
const GAP_SECONDS = 0.2; // 語音內部允許的最長停頓（超過就視為語音已結束）
const SNR_FLOOR = 1e-4; // 估計訊噪比時底噪的下限（-80dBFS），避免降噪後近乎零的底噪讓數字失真

// ---------- WAV 解析（只支援本程式自己寫出的 16-bit PCM WAV）----------
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是有效的 WAV 檔');

  let offset = 12;
  let channels = 2, sampleRate = SAMPLE_RATE, bits = 16, dataOffset = -1, dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, view.byteLength - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV 檔缺少 data 區塊');
  if (bits !== 16) throw new Error(`不支援 ${bits}-bit WAV`);

  const frames = Math.floor(dataSize / (2 * channels));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const p = dataOffset + i * 2 * channels;
    left[i] = view.getInt16(p, true) / 32768;
    right[i] = channels > 1 ? view.getInt16(p + 2, true) / 32768 : left[i];
  }
  return { left, right, sampleRate, channels };
}

// ---------- RNNoise 降噪 ----------
// createModule：vendor/rnnoise-sync.js 的預設匯出（createRNNWasmModuleSync）
export function createDenoiser(createModule) {
  const wasm = createModule();
  const inPtr = wasm._malloc(RNNOISE_FRAME * 4);
  const outPtr = wasm._malloc(RNNOISE_FRAME * 4);

  // 每個聲道要各自一個 RNNoise 狀態（模型內部有時間記憶，不能兩個聲道共用）
  function processChannel(input) {
    const state = wasm._rnnoise_create(0);
    const frames = Math.ceil(input.length / RNNOISE_FRAME);
    const out = new Float32Array(input.length);
    const inIdx = inPtr >> 2;
    const outIdx = outPtr >> 2;

    const runFrame = (f, write) => {
      const start = f * RNNOISE_FRAME;
      // RNNoise 期待 16-bit 數值範圍（±32768）的 float
      for (let i = 0; i < RNNOISE_FRAME; i++) {
        const s = start + i < input.length ? input[start + i] : 0;
        wasm.HEAPF32[inIdx + i] = s * 32768;
      }
      wasm._rnnoise_process_frame(state, outPtr, inPtr);
      if (write) {
        const n = Math.min(RNNOISE_FRAME, input.length - start);
        for (let i = 0; i < n; i++) out[start + i] = wasm.HEAPF32[outIdx + i] / 32768;
      }
    };

    // 暖機：RNNoise 剛建立時模型還沒收斂，開頭幾十毫秒會殘留雜訊。
    // 先把開頭一小段餵過一遍（輸出丟掉）讓內部狀態適應這段錄音的底噪，再從頭正式處理。
    const warmFrames = Math.min(frames, WARMUP_FRAMES);
    for (let f = 0; f < warmFrames; f++) runFrame(f, false);
    for (let f = 0; f < frames; f++) runFrame(f, true);

    wasm._rnnoise_destroy(state);
    return out;
  }

  return {
    process(left, right) {
      return { left: processChannel(left), right: processChannel(right) };
    },
    destroy() {
      wasm._free(inPtr);
      wasm._free(outPtr);
    },
  };
}

// ---------- 能量分析 ----------
function frameRms(left, right, frame = ANALYSIS_FRAME) {
  const n = Math.floor(left.length / frame);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) {
      const v = (left[i] + right[i]) * 0.5;
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / frame);
  }
  return rms;
}

const toDb = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -120);

function percentile(arr, p) {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

// 估計訊噪比：語音段落（高分位）RMS 對「最安靜 10%」視窗 RMS 的比值
export function estimateSnrDb(left, right) {
  const rms = frameRms(left, right);
  if (rms.length === 0) return 0;
  const noise = Math.max(percentile(rms, 0.1), SNR_FLOOR);
  const speech = percentile(rms, 0.95);
  return toDb(speech) - toDb(noise);
}

// ---------- 找語音起訖點（在降噪後的訊號上）----------
// 作法：先找到能量最大的視窗（一定在語音中），再往左右兩側擴展，直到連續超過 GAP_SECONDS 都低於門檻為止。
// 這樣即使降噪後開頭/結尾還有零星的殘留爆音，也不會被誤認成語音的一部分（只從「最大聲處」相連的區域擴展）。
// 門檻 = 最大能量往下 35dB，並且不低於「底噪 + 10dB」與絕對下限。
export function findSpeechRegion(left, right, sampleRate = SAMPLE_RATE) {
  const rms = frameRms(left, right);
  if (rms.length === 0) return null;

  let peakFrame = 0;
  for (let f = 1; f < rms.length; f++) if (rms[f] > rms[peakFrame]) peakFrame = f;
  const peakRms = rms[peakFrame];
  if (peakRms < SNR_FLOOR) return null; // 整段幾乎是零，沒有語音

  const noiseFloor = Math.max(percentile(rms, 0.1), SNR_FLOOR);
  const threshold = Math.max(peakRms * 0.0178, noiseFloor * 3.16, SNR_FLOOR); // -35dB 相對門檻 / 底噪+10dB
  const gapFrames = Math.round((sampleRate * GAP_SECONDS) / ANALYSIS_FRAME);

  let first = peakFrame;
  for (let f = peakFrame - 1, quiet = 0; f >= 0; f--) {
    if (rms[f] >= threshold) { first = f; quiet = 0; } else if (++quiet > gapFrames) break;
  }
  let last = peakFrame;
  for (let f = peakFrame + 1, quiet = 0; f < rms.length; f++) {
    if (rms[f] >= threshold) { last = f; quiet = 0; } else if (++quiet > gapFrames) break;
  }

  const guard = Math.floor(sampleRate * GUARD_SECONDS);
  return {
    start: Math.max(0, first * ANALYSIS_FRAME - guard),
    end: Math.min(left.length, (last + 1) * ANALYSIS_FRAME + guard),
  };
}

// ---------- 組合：淡入淡出 + 補真靜音 + 正規化 ----------
function fadeEdges(ch, fadeSamples) {
  const n = Math.min(fadeSamples, Math.floor(ch.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    ch[i] *= g;
    ch[ch.length - 1 - i] *= g;
  }
}

export function assembleClip(left, right, region, sampleRate = SAMPLE_RATE) {
  const voicedLen = region.end - region.start;
  const padSamples = Math.round(sampleRate * SILENCE_PAD_SECONDS);
  const total = voicedLen + padSamples * 2;
  const outL = new Float32Array(total); // 預設就是 0 → 真正的數位靜音
  const outR = new Float32Array(total);

  const vL = left.slice(region.start, region.end);
  const vR = right.slice(region.start, region.end);
  const fade = Math.floor(sampleRate * EDGE_FADE_SECONDS);
  fadeEdges(vL, fade);
  fadeEdges(vR, fade);

  // 正規化只看語音區段的峰值 → 靜音部分是 0，不會被放大；降噪後殘留的雜訊也比放大前小很多
  let peak = 0;
  for (let i = 0; i < voicedLen; i++) peak = Math.max(peak, Math.abs(vL[i]), Math.abs(vR[i]));
  const gain = peak > 1e-6 ? TARGET_PEAK / peak : 1;

  for (let i = 0; i < voicedLen; i++) {
    outL[padSamples + i] = vL[i] * gain;
    outR[padSamples + i] = vR[i] * gain;
  }
  return { left: outL, right: outR, gain, voicedSeconds: voicedLen / sampleRate };
}

// ---------- 單一檔案完整流程 ----------
// 回傳 { left, right, report }；如果整段沒有語音，left/right 為 null 並在 report.status 說明
export function optimizeAudio(wavArrayBuffer, denoiser) {
  const wav = parseWav(wavArrayBuffer);
  if (wav.sampleRate !== SAMPLE_RATE) {
    throw new Error(`取樣率 ${wav.sampleRate}Hz 不是 ${SAMPLE_RATE}Hz（這個 WAV 不是新版錄音存出來的）`);
  }

  const snrBefore = estimateSnrDb(wav.left, wav.right);
  const cleaned = denoiser.process(wav.left, wav.right);
  const snrAfter = estimateSnrDb(cleaned.left, cleaned.right);

  const region = findSpeechRegion(cleaned.left, cleaned.right);
  if (!region) {
    return {
      left: null,
      right: null,
      report: { status: 'no-speech', snrBefore, snrAfter, originalSeconds: wav.left.length / SAMPLE_RATE },
    };
  }

  const clip = assembleClip(cleaned.left, cleaned.right, region);
  const flags = [];
  if (snrBefore < 6) flags.push('原始訊噪比偏低');
  if (snrAfter < 20) flags.push('降噪後仍有明顯殘留雜訊');
  if (clip.voicedSeconds < 0.15) flags.push('語音過短');

  return {
    left: clip.left,
    right: clip.right,
    report: {
      status: flags.length ? 'review' : 'ok',
      flags,
      snrBefore,
      snrAfter,
      gainDb: toDb(clip.gain),
      voicedSeconds: clip.voicedSeconds,
      originalSeconds: wav.left.length / SAMPLE_RATE,
    },
  };
}
