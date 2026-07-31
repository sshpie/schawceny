# Schawceny

Capture the audio you hear in **claude.ai voice mode** — the synthesized voice —
to `.wav` + transcript, straight from the voice-mode WebSocket, inside your own
authenticated browser session.

claude.ai voice mode is a speech-in / speech-out transport: your mic goes up as Opus,
the synthesized reply comes back down as raw PCM. Schawceny wraps `window.WebSocket`,
keys on the `/api/ws/voice/` endpoint, collects the inbound 320-byte PCM frames, and
assembles them into a 16 kHz / mono / 16-bit WAV. The reply text is reconstructed from
the server's own `tts_word` frames, so each transcript is exactly what the voice said.

> **Scope.** This runs against *your own* logged-in session and only reads frames the
> server is already streaming to your tab. It sends nothing and contains no
> credentials. It's a "save what I'm hearing" tool, like a userscript that downloads
> your own audio.

## Quick start (userscript — recommended)

1. Install Tampermonkey / Violentmonkey.
2. Add [`userscript/schawceny.user.js`](userscript/schawceny.user.js).
3. Open claude.ai, start voice mode, talk. Each turn auto-downloads `.wav` + `.txt`.

It's `@run-at document-start`, so it installs the tap before claude.ai opens the
socket — no toggling — and because it runs in your real browser it never touches
Cloudflare.

## Other ways to run it

| Method | File | When |
|---|---|---|
| Userscript | `userscript/schawceny.user.js` | Default. Zero interaction, Cloudflare-proof. |
| Console snippet | `console/schawceny-console.js` | One-off, no install. Toggle voice off/on after pasting. |
| Playwright (existing session) | `docs/CAPTURE_METHODS.md` | You already have a logged-in Playwright/MCP browser. |
| Playwright (CDP + real Chrome) | `playwright/schawceny_cdp.py` | Standalone; launches your real Chrome, attaches over CDP. |

See [`docs/CAPTURE_METHODS.md`](docs/CAPTURE_METHODS.md) for details and
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the WebSocket protocol.

## How it works (one paragraph)

`window.WebSocket` is subclassed before the app loads. When a socket to
`/api/ws/voice/...` is constructed, a `message` listener collects binary frames
(`ArrayBuffer`/`Blob`) as raw PCM and parses `tts_word` JSON for the transcript.
Each frame resets a 1.5 s silence timer; when it fires, the accumulated frames
finalize into one turn and a WAV is emitted. That silence-debounce cleanly separates
conversational turns while holding long single turns together.

## Samples

[`samples/`](samples/) contains a real 11-turn, ~250 s session captured with the
Playwright method — individual turns, a concatenated `session-all.wav`, a full
`TRANSCRIPT.txt`, and `manifest.json`. Included so you can hear the output quality
(e.g. `turn3` is a 98.7 s count-to-100 captured as one unbroken turn) without running
anything.

## Format

Inbound audio is fixed at `output_format=pcm_16000`: 16 kHz, mono, 16-bit PCM,
one 320-byte frame per 10 ms. WAV assembly is just concatenation + a 44-byte header —
no resampling, no re-encoding.

## License

MIT — see [LICENSE](LICENSE).
