# Schwaceny — capture methods

Three ways to run the same tap. They all wrap `window.WebSocket`, key on the
`/api/ws/voice/` endpoint, collect the inbound 320-byte PCM frames, and assemble
them into a 16 kHz / mono / 16-bit WAV. Pick by how much automation you want.

All three run inside **your own authenticated browser session** — there are no
credentials in this repo. The tap only reads frames the server is already sending
to your tab; it sends nothing.

---

## 1. Userscript (recommended — zero interaction, Cloudflare-proof)

`userscript/schwaceny.user.js`

1. Install Tampermonkey (or Violentmonkey) in your normal browser.
2. Add the userscript. It is `@match https://claude.ai/*` and `@run-at document-start`,
   so it installs the tap **before** claude.ai's app code constructs the WebSocket —
   no toggling voice mode needed.
3. Open claude.ai, start voice mode, talk. Each turn auto-downloads a `.wav` + `.txt`.
   A small floating panel shows status and offers Save-last / Save-all / Transcript.

Because it runs in your real browser, it never touches Cloudflare Turnstile.

---

## 2. Console snippet (quick, no install)

`console/schwaceny-console.js`

Paste into DevTools console on claude.ai, then toggle voice mode **off then on** so
the socket the app opens is the wrapped one. After a turn:

```js
__schwaceny.save()        // whole session -> WAV
__schwaceny.save('last')  // last turn only
__schwaceny.transcript()  // tts_word text
```

---

## 3. Playwright — driving an existing session (what these samples were captured with)

If you already have a Playwright browser that is logged into claude.ai (for example
the Playwright MCP tools in Claude Code), you do **not** need to launch anything or
fight Cloudflare — that browser is already a real, authenticated, cleared session.
Inject the tap and drain it.

**Install the tap at document-start, then navigate:**

```js
// browser_run_code_unsafe (Playwright server, has `page`)
await page.addInitScript(TAP);                 // TAP = the wrapper, draining into window.__schwacenyTurns
await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded' });
```

**Grant mic + confirm a real input device:**

```js
await page.context().grantPermissions(['microphone'], { origin: 'https://claude.ai' });
```

**Click “Use voice mode”, talk, then drain the finalized-turns buffer:**

```js
// browser_evaluate, saving the (JSON-encoded) result straight to disk
() => { const t = (window.__schwacenyTurns||[]).slice(); window.__schwacenyTurns=[]; return JSON.stringify(t); }
```

Decode host-side (note the result is JSON-encoded, so parse twice):

```python
import json, base64
raw = json.load(open('drain.json'))
turns = json.loads(raw) if isinstance(raw, str) else raw
for t in turns:
    open(f"turn{t['n']}.wav", 'wb').write(base64.b64decode(t['b64']))
```

The drain-into-a-global variant of the tap (`window.__schwacenyTurns.push(...)`)
is what you use when you cannot expose a Python binding to the page. When you *can*
(a standalone script), use `expose_binding` instead — see `playwright/schwaceny_cdp.py`.

### If you have no logged-in Playwright session

`playwright/schwaceny_cdp.py` launches your real Chrome binary against a synced copy
of your logged-in profile with no automation flags, then attaches over CDP. This is
the only variant that has to think about Cloudflare, and it beats it by never letting
Playwright launch the browser.

---

## Turn segmentation

Each inbound audio frame resets a 1.5 s timer; when the timer fires (1.5 s of silence)
the accumulated frames finalize into one turn. This cleanly separates conversational
turns and holds arbitrarily long single turns together (the sample set includes a
98.7 s count-to-100 captured as one unbroken turn). Transcripts come from the server's
own `tts_word` frames, so the text is exactly what the voice said.
