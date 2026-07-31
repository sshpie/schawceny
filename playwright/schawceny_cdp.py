#!/usr/bin/env python3
"""
schawceny_cdp.py — attach to your REAL Google Chrome over CDP and auto-capture
claude.ai voice-mode audio to WAV + transcript.

Why CDP-attach instead of launching Chromium: an automation-launched browser
(Playwright's launch/launch_persistent_context) trips Cloudflare Turnstile. This
script instead launches YOUR actual Chrome binary against a synced copy of your
logged-in profile (trusted browser + trusted cookies + real fingerprint) with NO
automation flags, then connects over CDP afterward — which does not set
navigator.webdriver. Turnstile sees an ordinary Chrome.

NOTE: If you already have a Playwright MCP browser session (e.g. Claude Code's
Playwright tools), the simpler path is to drive that session directly — see
../docs/CAPTURE_METHODS.md. This script is the standalone/headless-friendly variant.

Usage
  1. (recommended) Close your normal Chrome so the profile copy is clean.
  2. python3 schawceny_cdp.py
  3. In the Chrome window that opens (already on claude.ai), start a voice turn.
  4. Each turn auto-writes ./voice-captures/turnN-<ts>.wav + .txt
  Ctrl+C to stop.

Requires: playwright, a Google Chrome install (rsync optional but recommended).
"""
import base64
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 9222
SRC_PROFILE = Path.home() / ".config/google-chrome"
DST_PROFILE = Path.home() / ".schawceny-chrome-profile"
OUTDIR = Path("./voice-captures")
URL = "https://claude.ai/new"
SILENCE_MS = 1500
SR = 16000

CHROME_CANDIDATES = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    shutil.which("google-chrome-stable") or "",
    shutil.which("google-chrome") or "",
]

CACHE_EXCLUDES = [
    "Cache", "Code Cache", "GPUCache", "GraphiteDawnCache", "ShaderCache",
    "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage",
    "component_crx_cache", "optimization_guide_model_store", "Crashpad",
]

# --- page-side tap: installed at document-start via CDP add_init_script ---
INIT_SCRIPT = r"""
(() => {
  if (window.__schawcenyInstalled) return;
  window.__schawcenyInstalled = true;
  const SR = %d, SILENCE_MS = %d, Orig = window.WebSocket;
  let seg = [], words = [], turnN = 0, timer = null;
  function wavB64(byteArrays) {
    const total = byteArrays.reduce((a,b)=>a+b.length,0);
    const buf = new ArrayBuffer(44+total), dv = new DataView(buf);
    const wr=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
    wr(0,'RIFF');dv.setUint32(4,36+total,true);wr(8,'WAVE');wr(12,'fmt ');
    dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);
    dv.setUint32(24,SR,true);dv.setUint32(28,SR*2,true);dv.setUint16(32,2,true);
    dv.setUint16(34,16,true);wr(36,'data');dv.setUint32(40,total,true);
    let off=44; for(const a of byteArrays){ new Uint8Array(buf,off,a.length).set(a); off+=a.length; }
    let bin=''; const u8=new Uint8Array(buf);
    for(let i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]);
    return btoa(bin);
  }
  function finalize(){ if(!seg.length) return; turnN++;
    const b64=wavB64(seg), text=words.map(w=>w.text).join('');
    if (window.__schawcenySave) window.__schawcenySave(b64, text, turnN);
    seg=[]; words=[]; }
  function onAudio(b){ seg.push(b); clearTimeout(timer); timer=setTimeout(finalize, SILENCE_MS); }
  class TappedWS extends Orig {
    constructor(url, protocols){
      super(url, protocols);
      if (typeof url==='string' && url.includes('/api/ws/voice/')){
        console.log('[schawceny] voice socket tapped');
        this.addEventListener('close', finalize);
        this.addEventListener('message', (ev)=>{ const d=ev.data;
          if (d instanceof ArrayBuffer) onAudio(new Uint8Array(d.slice(0)));
          else if (d instanceof Blob) d.arrayBuffer().then(b=>onAudio(new Uint8Array(b)));
          else if (typeof d==='string'){ let m; try{m=JSON.parse(d);}catch{return;}
            if (m.type==='tts_word') words.push({text:m.text}); } });
      }
    }
  }
  window.WebSocket = TappedWS;
  console.log('[schawceny] tap installed at document-start');
})();
""" % (SR, SILENCE_MS)


def find_chrome():
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    return None


def sync_profile():
    if not SRC_PROFILE.exists():
        print(f"[schawceny] {SRC_PROFILE} not found — launching a fresh profile; you'll log in once (persists).")
        DST_PROFILE.mkdir(parents=True, exist_ok=True)
        return
    print(f"[schawceny] syncing profile (login + Cloudflare trust) -> {DST_PROFILE}")
    DST_PROFILE.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsync"):
        cmd = ["rsync", "-a", "--delete"]
        for e in CACHE_EXCLUDES:
            # match at any depth so nested caches are actually pruned
            cmd += ["--exclude", e, "--exclude", f"**/{e}"]
        cmd += [f"{SRC_PROFILE}/", f"{DST_PROFILE}/"]
        subprocess.run(cmd, check=False)
    else:
        print("[schawceny] rsync not found — falling back to cp -a (slower, copies caches too)")
        subprocess.run(["cp", "-a", f"{SRC_PROFILE}/.", f"{DST_PROFILE}/"], check=False)
        for e in CACHE_EXCLUDES:
            for p in DST_PROFILE.glob(f"**/{e}"):
                shutil.rmtree(p, ignore_errors=True)
    for lk in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            (DST_PROFILE / lk).unlink()
        except FileNotFoundError:
            pass


def wait_for_devtools(timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def main():
    chrome = find_chrome()
    if not chrome:
        print("[schawceny] ERROR: no Google Chrome binary found. Install Chrome or edit CHROME_CANDIDATES.")
        return 1
    print(f"[schawceny] chrome: {chrome}")

    OUTDIR.mkdir(exist_ok=True)
    sync_profile()

    proc = subprocess.Popen(
        [chrome,
         f"--remote-debugging-port={PORT}",
         f"--user-data-dir={DST_PROFILE}",
         "--no-first-run", "--no-default-browser-check",
         "--restore-last-session=false",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"[schawceny] launched Chrome (pid {proc.pid}) with CDP on :{PORT}")

    if not wait_for_devtools():
        print("[schawceny] ERROR: CDP endpoint never came up. Is another Chrome using this profile/port?")
        proc.terminate()
        return 1

    turn_counter = {"n": 0}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        def save_turn(source, b64wav, transcript, turn_no):
            turn_counter["n"] = max(turn_counter["n"], turn_no)
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            wav = OUTDIR / f"turn{turn_no}-{ts}.wav"
            wav.write_bytes(base64.b64decode(b64wav))
            dur = (wav.stat().st_size - 44) / (SR * 2)
            line = f"[schawceny] turn {turn_no}: {wav.name}  (~{dur:.1f}s)"
            if transcript.strip():
                (OUTDIR / f"turn{turn_no}-{ts}.txt").write_text(transcript.strip() + "\n")
                line += f'  "{transcript.strip()[:50]}"'
            print(line, flush=True)

        ctx.expose_binding("__schawcenySave", save_turn)
        ctx.add_init_script(INIT_SCRIPT)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(URL)

        print("\n[schawceny] Chrome is on claude.ai. If not logged in, log in once (profile persists).")
        print("[schawceny] Start a voice turn and talk — each response auto-saves. Ctrl+C to quit.\n")
        try:
            # Monitor browser connectivity, NOT the launcher PID: Chrome re-execs itself
            # on startup, orphaning the process we spawned, so proc.poll() would false-positive.
            while browser.is_connected():
                time.sleep(1)
            print("[schawceny] browser disconnected.")
        except KeyboardInterrupt:
            print(f"\n[schawceny] stopping — {turn_counter['n']} turn(s) captured to {OUTDIR.resolve()}")
        finally:
            try:
                proc.terminate()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
