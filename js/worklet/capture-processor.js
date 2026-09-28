// capture-processor.js
// 在獨立的「音訊執行緒」上執行（不是主執行緒），所以就算主執行緒在忙（DOM 更新、GC、
// 甚至偶爾的卡頓），這裡的錄音擷取都不會被影響——這是它比舊版 ScriptProcessorNode
// 更穩定、更不容易漏格產生爆音雜訊的原因。
//
// AudioWorklet 每次 process() 只會拿到 128 個樣本（render quantum），如果每次都直接
// postMessage 回主執行緒，訊息量太密集，所以這裡先在 worklet 內部累積成較大的區塊
// （CHUNK_SIZE），累積滿了才送一次，減少訊息傳遞的開銷。

const CHUNK_SIZE = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.leftBuf = new Float32Array(CHUNK_SIZE);
    this.rightBuf = new Float32Array(CHUNK_SIZE);
    this.writeIndex = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.active = false;
    };
  }

  flush() {
    if (this.writeIndex === 0) return;
    const left = this.leftBuf.slice(0, this.writeIndex);
    const right = this.rightBuf.slice(0, this.writeIndex);
    this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    this.writeIndex = 0;
  }

  process(inputs) {
    if (!this.active) return false;

    const input = inputs[0];
    if (input && input.length > 0) {
      const left = input[0];
      const right = input.length > 1 ? input[1] : input[0];

      for (let i = 0; i < left.length; i++) {
        this.leftBuf[this.writeIndex] = left[i];
        this.rightBuf[this.writeIndex] = right[i];
        this.writeIndex++;
        if (this.writeIndex >= CHUNK_SIZE) this.flush();
      }
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
