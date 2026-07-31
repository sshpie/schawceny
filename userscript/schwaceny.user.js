// ==UserScript==
// @name         Schwaceny — Claude Voice Capture
// @namespace    schwaceny
// @version      1.0
// @description  Capture claude.ai voice-mode TTS audio (the synthesized voice you hear) to WAV + transcript, from your own authenticated browser session. Zero console interaction, no toggling.
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  const SR = 16000;                 // output_format=pcm_16000
  const SILENCE_MS = 1500;          // gap of silence that ends a turn
  const Orig = window.WebSocket;
  if (window.__schwacenyInstalled) return;
  window.__schwacenyInstalled = true;

  const state = {
    seg: [], segWords: [], all: [], allWords: [], turnN: 0,
    autoSave: true, finalizeTimer: null,
  };

  // ---- WAV assembly: 320B raw PCM frames -> 16kHz/mono/16-bit WAV ----
  function wav(byteArrays) {
    const total = byteArrays.reduce((a, b) => a + b.length, 0);
    const buf = new ArrayBuffer(44 + total), dv = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); dv.setUint32(4, 36 + total, true); wr(8, 'WAVE'); wr(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, total, true);
    let off = 44; for (const a of byteArrays) { new Uint8Array(buf, off, a.length).set(a); off += a.length; }
    return new Blob([buf], { type: 'audio/wav' });
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function secs(arr) { return (arr.reduce((x, b) => x + b.length, 0) / (SR * 2)).toFixed(1); }

  // ---- turn lifecycle: each frame resets a 1.5s timer; timeout finalizes the turn ----
  function finalizeTurn() {
    if (!state.seg.length) return;
    state.turnN++;
    const n = state.turnN, dur = secs(state.seg), text = state.segWords.map(w => w.text).join('');
    if (state.autoSave) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      download(wav(state.seg), `claude-voice-turn${n}-${stamp}.wav`);
      if (text.trim()) download(new Blob([text.trim() + '\n'], { type: 'text/plain' }), `claude-voice-turn${n}-${stamp}.txt`);
    }
    log(`turn ${n} saved · ${dur}s · "${text.trim().slice(0, 48)}${text.length > 48 ? '…' : ''}"`);
    state.seg = []; state.segWords = [];
    render();
  }
  function onAudio(bytes) {
    state.seg.push(bytes); state.all.push(bytes);
    clearTimeout(state.finalizeTimer);
    state.finalizeTimer = setTimeout(finalizeTurn, SILENCE_MS);
    render();
  }

  // ---- WebSocket tap: wrap the constructor, key on the voice endpoint ----
  class TappedWS extends Orig {
    constructor(url, protocols) {
      super(url, protocols);
      if (typeof url === 'string' && url.includes('/api/ws/voice/')) {
        log('voice socket tapped');
        badge(true);
        this.addEventListener('close', () => { badge(false); finalizeTurn(); });
        this.addEventListener('message', (ev) => {
          const d = ev.data;
          if (d instanceof ArrayBuffer) onAudio(new Uint8Array(d.slice(0)));          // binary PCM frame
          else if (d instanceof Blob) d.arrayBuffer().then(b => onAudio(new Uint8Array(b)));
          else if (typeof d === 'string') {
            let m; try { m = JSON.parse(d); } catch { return; }
            if (m.type === 'tts_word') { state.segWords.push({ text: m.text }); state.allWords.push({ text: m.text }); }
          }
        });
      }
    }
  }
  window.WebSocket = TappedWS;

  // ---- floating control panel ----
  let ui = {};
  function buildUI() {
    if (document.getElementById('schwaceny')) return;
    const p = document.createElement('div'); p.id = 'schwaceny';
    p.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;'
      + 'background:#16181c;color:#e6e6e6;border:1px solid #2a2d34;border-radius:10px;padding:10px 12px;width:220px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.4);user-select:none';
    p.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span id="sch-dot" style="width:9px;height:9px;border-radius:50%;background:#555;display:inline-block"></span>
        <b style="font-weight:600">Schwaceny</b>
      </div>
      <div id="sch-stat" style="color:#9aa0aa;margin-bottom:8px">idle — start a voice turn</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <button id="sch-last">Save last</button>
        <button id="sch-all">Save all</button>
        <button id="sch-tx">Transcript</button>
        <button id="sch-clr">Clear</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;color:#9aa0aa">
        <input id="sch-auto" type="checkbox" checked> auto-save each turn
      </label>`;
    p.querySelectorAll('button').forEach(b => b.style.cssText =
      'background:#232730;color:#e6e6e6;border:1px solid #333842;border-radius:6px;padding:5px 6px;cursor:pointer;font:11px system-ui');
    (document.body || document.documentElement).appendChild(p);
    ui = { dot: p.querySelector('#sch-dot'), stat: p.querySelector('#sch-stat'), auto: p.querySelector('#sch-auto') };
    p.querySelector('#sch-last').onclick = () => state.seg.length ? download(wav(state.seg), `claude-voice-current-${Date.now()}.wav`)
      : (state.all.length ? download(wav(state.all), `claude-voice-all-${Date.now()}.wav`) : log('nothing captured'));
    p.querySelector('#sch-all').onclick = () => state.all.length ? download(wav(state.all), `claude-voice-session-${Date.now()}.wav`) : log('nothing captured');
    p.querySelector('#sch-tx').onclick = () => {
      const t = state.allWords.map(w => w.text).join('').trim();
      if (t) { navigator.clipboard?.writeText(t); download(new Blob([t + '\n'], { type: 'text/plain' }), `claude-voice-transcript-${Date.now()}.txt`); log('transcript copied + saved'); }
      else log('no transcript yet');
    };
    p.querySelector('#sch-clr').onclick = () => { state.seg = []; state.segWords = []; state.all = []; state.allWords = []; log('cleared'); render(); };
    ui.auto.onchange = () => { state.autoSave = ui.auto.checked; };
  }
  function badge(on) { if (ui.dot) ui.dot.style.background = on ? '#e5484d' : '#555'; }
  function render() {
    if (!ui.stat) return;
    ui.stat.textContent = state.seg.length
      ? `● recording · turn ${state.turnN + 1} · ${secs(state.seg)}s`
      : `idle · ${state.turnN} turn(s) · ${secs(state.all)}s total`;
  }
  function log(msg) { console.log('[schwaceny]', msg); if (ui.stat) { ui.stat.textContent = msg; setTimeout(render, 2500); } }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();
  console.log('[schwaceny] installed at document-start — no toggle needed');
})();
