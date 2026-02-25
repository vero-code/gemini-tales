"""
Narrator WebSocket endpoint.

Flow:
  Browser  ←──WebSocket──→  FastAPI /ws/narrator  ←──genai Live──→  Gemini

Message protocol (browser → server):
  { "type": "init",  "story": "<markdown text>" }          # first message
  { "type": "audio", "data": "<base64 PCM 16-bit 16kHz>" } # mic chunks
  { "type": "text",  "text": "<question text>" }           # text fallback

Message protocol (server → browser):
  { "type": "audio",        "data": "<base64 PCM 16-bit 24kHz>" }
  { "type": "transcript",   "text": "...", "role": "user"|"model" }
  { "type": "interrupted" }
  { "type": "error",        "text": "..." }
"""

import asyncio
import base64
import json
import logging
import os

from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

MODEL = "gemini-live-2.5-flash-native-audio"

NARRATOR_SYSTEM_PROMPT = """You are a warm, patient, and imaginative narrator reading a children's story.

Your job:
1. Read the story text provided to you at the start of the session naturally and engagingly, as if telling it to a child aged 5–10.
2. You MUST pause and listen whenever the child speaks — they can interrupt you at any time (barge-in).
3. When the child asks a question or makes a comment, respond kindly and in simple language, then offer to continue the story.
4. Keep your voice gentle, expressive, and full of wonder. Use dramatic pauses and vary your pace.
5. Never lecture. If the child goes off-topic, gently steer back to the story in a fun way.
6. Speak in the same language the child uses."""


def _build_config(story_text: str) -> types.LiveConnectConfig:
    system_instruction = (
        NARRATOR_SYSTEM_PROMPT
        + "\n\n--- STORY TO READ ---\n"
        + story_text
        + "\n--- END OF STORY ---\n\n"
        + "Begin by warmly greeting the child and then start reading the story from the beginning."
    )
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_instruction,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


async def narrator_ws_endpoint(websocket: WebSocket):
    """Main WebSocket handler – mount this in main.py."""
    await websocket.accept()
    logger.info("Narrator WebSocket connected")

    # ── 1. Wait for init message with story text ──────────────────────────────
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        msg = json.loads(raw)
    except asyncio.TimeoutError:
        await websocket.send_text(json.dumps({"type": "error", "text": "Timeout waiting for init message."}))
        await websocket.close()
        return

    if msg.get("type") != "init" or not msg.get("story"):
        await websocket.send_text(json.dumps({"type": "error", "text": "Expected init message with story text."}))
        await websocket.close()
        return

    story_text = msg["story"]
    config = _build_config(story_text)

    use_vertex = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() == "true"
    if use_vertex:
        client = genai.Client(
            vertexai=True,
            project=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
        )
    else:
        client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

    # ── 2. Open Live session ───────────────────────────────────────────────────
    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Gemini Live session opened")

            async def send_loop():
                """Read messages from browser and forward to Gemini."""
                try:
                    while True:
                        raw = await websocket.receive_text()
                        msg = json.loads(raw)
                        mtype = msg.get("type")

                        if mtype == "audio":
                            pcm_bytes = base64.b64decode(msg["data"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=pcm_bytes, mime_type="audio/pcm;rate=16000")
                            )
                        elif mtype == "text":
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part(text=msg["text"])])],
                                turn_complete=True,
                            )
                except WebSocketDisconnect:
                    logger.info("Browser disconnected (send_loop)")
                except Exception as e:
                    logger.error(f"send_loop error: {e}")

            async def recv_loop():
                """Read responses from Gemini and forward to browser."""
                try:
                    async for response in session.receive():
                        # Audio output
                        if response.data:
                            b64 = base64.b64encode(response.data).decode()
                            await websocket.send_text(json.dumps({"type": "audio", "data": b64}))

                        # Server-side transcripts
                        if response.server_content:
                            sc = response.server_content

                            # Input transcript (what child said)
                            if sc.input_transcription and sc.input_transcription.text:
                                await websocket.send_text(json.dumps({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": sc.input_transcription.text,
                                }))

                            # Output transcript (what narrator said)
                            if sc.output_transcription and sc.output_transcription.text:
                                await websocket.send_text(json.dumps({
                                    "type": "transcript",
                                    "role": "model",
                                    "text": sc.output_transcription.text,
                                }))

                            # Interrupted (barge-in)
                            if sc.interrupted:
                                await websocket.send_text(json.dumps({"type": "interrupted"}))

                except WebSocketDisconnect:
                    logger.info("Browser disconnected (recv_loop)")
                except Exception as e:
                    logger.error(f"recv_loop error: {e}")

            await asyncio.gather(send_loop(), recv_loop())

    except Exception as e:
        logger.error(f"Live session error: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "text": str(e)}))
        except Exception:
            pass
    finally:
        logger.info("Narrator WebSocket closed")
