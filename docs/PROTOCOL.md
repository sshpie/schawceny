# claude.ai voice-mode WebSocket — protocol notes

Reverse-engineered from the client bundle and confirmed on the wire. This documents
the transport Schwaceny taps. All identifiers below are placeholders — substitute
your own session's values (they are visible in your browser's DevTools).

## Endpoint

```
wss://claude.ai/api/ws/voice/organizations/{ORG_ID}/chat_conversations/{CONV_ID}
```

## Query parameters (14)

```
input_encoding=opus
input_sample_rate=16000
input_channels=1
output_format=pcm_16000
language=en-US
timezone={TZ}
tts_speed=1.00                 # clamped 0.70–1.20 client-side
server_interrupt_enabled=true
client_aec=true
client_platform=web_claude_ai
voice=glassy                   # default "buttery"; several voices exist
model=claude-sonnet-5
effort=medium
thinking_mode=auto
```

## It is speech-in / speech-out only

There is **no text-input path** on this socket. The client class exposes
`sendAudio` (binary Opus mic frames), `sendControl`, `sendToolsRegister`,
`sendClientMetrics`, `sendClientAbortReason`, `sendClockSyncPing` — and no
`sendText` / `sendUserMessage`. Sending `{"type":"user_message","text":...}` yields
`conversation_ready` and then silence; the server does not synthesize typed text.
To get audio out, real speech (or injected audio) has to go in.

## Message types

**Outbound (client → server)**
- binary Opus mic frames (~35–48 B each)
- `{"type":"client_metrics", ...}` telemetry
- control JSON via `sendControl` — `interrupt`, `playback_complete`, `turn_end`, `flush`

**Inbound (server → client)** — what Schwaceny reads:
- **binary 320-byte raw PCM frames** — 16 kHz / 16-bit / mono = one 10 ms frame each.
  This is the synthesized voice. Audio is **binary** (`ArrayBuffer` / `Blob`), not
  JSON/base64.
- `{"type":"tts_word","text":"...","pts_ms":N}` — word timing; concatenated, this is
  the verbatim transcript of what the voice says.
- `{"type":"message_sse","event":{"type":"content_block_delta","data":{...,"delta":{"type":"text_delta","text":"..."}}}}`
  — the streaming reply text (same content, SSE-style).

## WAV assembly

Concatenate the 320-byte PCM frames and prepend a 44-byte WAV header
(PCM, 1 channel, 16000 Hz sample rate, 16-bit). No resampling or re-encoding is
needed because `output_format` is fixed at `pcm_16000`.

## Why a raw WebSocket client gets 403

Connecting from Python/`websockets` with the exact cookies still 403s: the block is
TLS/JA3 fingerprinting plus Cloudflare, not missing auth. The practical answer is to
run inside a real browser session — which is exactly what Schwaceny does.
