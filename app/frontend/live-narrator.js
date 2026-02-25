/**
 * live-narrator.js  —  Connects the story page to the Gemini Live narrator.
 *
 * Public API (instantiated from story.html):
 *   const narrator = new LiveNarrator(storyText);
 *   narrator.start();   // opens WS, requests mic, starts streaming
 *   narrator.stop();    // closes everything cleanly
 *
 * Events fired on the narrator instance (EventTarget):
 *   "status"      detail: { text: string }
 *   "transcript"  detail: { role: "user"|"model", text: string }
 *   "error"       detail: { text: string }
 */

class LiveNarrator extends EventTarget {
  constructor(storyText) {
    super();
    this._story = storyText;
    this._ws = null;
    this._audioCtx = null;
    this._micStream = null;
    this._workletNode = null;
    this._playbackQueue = [];   // array of Float32Array
    this._isPlaying = false;
    this._nextPlayTime = 0;
    this._active = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start() {
    if (this._active) return;
    this._active = true;
    this._emit("status", { text: "🔗 Connecting to narrator..." });

    try {
      // 1. Open WebSocket
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this._ws = new WebSocket(`${proto}//${location.host}/ws/narrator`);
      this._ws.binaryType = "arraybuffer";

      await this._waitForOpen();

      // 2. Send init with story text
      this._ws.send(JSON.stringify({ type: "init", story: this._story }));

      // 3. Set up incoming message handler
      this._ws.addEventListener("message", (e) => this._handleServerMsg(e));
      this._ws.addEventListener("close", () => {
        this._emit("status", { text: "📖 Session ended." });
        this.stop();
      });
      this._ws.addEventListener("error", () => {
        this._emit("error", { text: "WebSocket connection error." });
        this.stop();
      });

      // 4. Start AudioContext for output playback
      this._audioCtx = new AudioContext({ sampleRate: 24000 });

      // 5. Start microphone capture
      await this._startMic();

      this._emit("status", { text: "🎙️ Narrator is ready — listening..." });
    } catch (err) {
      this._emit("error", { text: `Failed to start: ${err.message}` });
      this.stop();
    }
  }

  stop() {
    this._active = false;

    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._micStream)   { this._micStream.getTracks().forEach(t => t.stop()); this._micStream = null; }
    if (this._audioCtx)    { this._audioCtx.close(); this._audioCtx = null; }
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) { this._ws.close(); }
    this._ws = null;
    this._playbackQueue = [];
    this._isPlaying = false;
  }

  /** Send a text question (used when microphone is unavailable) */
  sendText(text) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: "text", text }));
    }
  }

  // ── Audio input ─────────────────────────────────────────────────────────────

  async _startMic() {
    this._micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });

    const micCtx = new AudioContext({ sampleRate: 16000 });
    const source = micCtx.createMediaStreamSource(this._micStream);

    // Load worklet
    await micCtx.audioWorklet.addModule("pcm-processor.js");
    this._workletNode = new AudioWorkletNode(micCtx, "pcm-recorder");

    this._workletNode.port.onmessage = (e) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const int16 = e.data; // Int16Array
      const b64 = this._int16ToBase64(int16);
      this._ws.send(JSON.stringify({ type: "audio", data: b64 }));
    };

    source.connect(this._workletNode);
    // Don't connect to destination — we don't want mic feedback
  }

  // ── Audio output ────────────────────────────────────────────────────────────

  _handleServerMsg(event) {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "audio":
        this._enqueueAudio(msg.data);
        break;
      case "transcript":
        this._emit("transcript", { role: msg.role, text: msg.text });
        break;
      case "interrupted":
        // Clear queued audio to stop the narrator mid-sentence
        this._playbackQueue = [];
        this._isPlaying = false;
        this._emit("status", { text: "🎙️ Listening to you..." });
        break;
      case "error":
        this._emit("error", { text: msg.text });
        break;
    }
  }

  _enqueueAudio(base64pcm) {
    if (!this._audioCtx) return;
    const int16 = this._base64ToInt16(base64pcm);
    // Convert Int16 → Float32
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }
    this._playbackQueue.push(float32);
    if (!this._isPlaying) this._drainQueue();
  }

  _drainQueue() {
    if (!this._audioCtx || this._playbackQueue.length === 0) {
      this._isPlaying = false;
      return;
    }
    this._isPlaying = true;

    const chunk = this._playbackQueue.shift();
    const buffer = this._audioCtx.createBuffer(1, chunk.length, 24000);
    buffer.copyToChannel(chunk, 0);

    const source = this._audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this._audioCtx.destination);

    const now = this._audioCtx.currentTime;
    const startAt = Math.max(now, this._nextPlayTime);
    source.start(startAt);
    this._nextPlayTime = startAt + buffer.duration;

    source.onended = () => this._drainQueue();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _waitForOpen() {
    return new Promise((resolve, reject) => {
      this._ws.addEventListener("open", resolve, { once: true });
      this._ws.addEventListener("error", reject, { once: true });
    });
  }

  _int16ToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  _base64ToInt16(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

window.LiveNarrator = LiveNarrator;
