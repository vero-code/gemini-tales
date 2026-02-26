import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useGeminiLive Hook
 * Encapsulates WebSocket connectivity, audio capture, and playback for Gemini Live.
 */
export const useGeminiLive = (options = {}) => {
  const {
    proxyUrl = `ws://${window.location.host}/ws/proxy`,
    systemInstruction = "",
    onMessage = () => {},
    onStatusChange = () => {},
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioWorkletRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const playbackWorkletRef = useRef(null);
  const gainNodeRef = useRef(null);

  // --- AUDIO CAPTURE (MIC) ---
  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule('/audio-processors/capture.worklet.js');
      const worklet = new AudioWorkletNode(audioCtx, 'audio-capture-processor');
      audioWorkletRef.current = worklet;

      worklet.port.onmessage = (event) => {
        if (event.data.type === 'audio' && socketRef.current?.readyState === WebSocket.OPEN) {
          const float32 = event.data.data;
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
          }
          const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
          socketRef.current.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{ mime_type: "audio/pcm", data: base64 }]
            }
          }));
        }
      };

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(worklet);
      setIsStreaming(true);
    } catch (err) {
      console.error("Mic access failed:", err);
      setError("Microphone access denied.");
    }
  };

  const stopAudioCapture = () => {
    setIsStreaming(false);
    audioWorkletRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();
  };

  // --- AUDIO PLAYBACK (SPEAKER) ---
  const initPlayback = async () => {
    if (playbackWorkletRef.current) return;
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    await audioCtx.audioWorklet.addModule('/audio-processors/playback.worklet.js');
    const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
    const gain = audioCtx.createGain();
    worklet.connect(gain);
    gain.connect(audioCtx.destination);
    playbackWorkletRef.current = worklet;
    gainNodeRef.current = gain;
  };

  const playAudioChunk = async (base64) => {
    if (!playbackWorkletRef.current) await initPlayback();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    playbackWorkletRef.current.port.postMessage(float32);
  };

  // --- WEBSOCKET ---
  const connect = useCallback(() => {
    const ws = new WebSocket(proxyUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Send Setup
      ws.send(JSON.stringify({ service_url: "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent" }));
      ws.send(JSON.stringify({
        setup: {
          model: `projects/${import.meta.env.VITE_GCP_PROJECT || 'gemini-tales'}/locations/us-central1/publishers/google/models/gemini-2.0-flash-exp`,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: { parts: [{ text: systemInstruction }] },
          realtime_input_config: {
            automatic_activity_detection: { disabled: false, silence_duration_ms: 2000 }
          }
        }
      }));
      startAudioCapture();
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            await playAudioChunk(part.inlineData.data);
          }
        }
      }
      onMessage(data);
    };

    ws.onclose = () => {
      setIsConnected(false);
      stopAudioCapture();
    };

    ws.onerror = (err) => {
      console.error("WS Error:", err);
      setError("WebSocket connection failed.");
    };
  }, [proxyUrl, systemInstruction]);

  const disconnect = () => {
    socketRef.current?.close();
  };

  useEffect(() => {
    return () => disconnect();
  }, []);

  return { isConnected, isStreaming, error, connect, disconnect };
};
