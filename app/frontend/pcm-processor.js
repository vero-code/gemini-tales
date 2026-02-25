/**
 * AudioWorkletProcessor that collects raw PCM samples from the microphone
 * and posts Int16 chunks back to the main thread.
 *
 * Registered as "pcm-recorder" via AudioWorklet.
 */
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Send ~100ms chunks: 16000 samples/s * 0.1s = 1600 samples
    this._chunkSize = 1600;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array
    for (let i = 0; i < samples.length; i++) {
      // Clamp and convert float32 → int16
      const s = Math.max(-1, Math.min(1, samples[i]));
      this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      this.port.postMessage(new Int16Array(chunk));
    }

    return true; // keep processor alive
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
