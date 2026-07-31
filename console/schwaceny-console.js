/* Schwaceny (console variant) — intercept claude.ai voice-mode inbound audio -> WAV + transcript.
   Paste into DevTools console on claude.ai, then toggle voice mode OFF then ON (so the tapped
   WebSocket is the one the app opens). After a spoken turn:
     __schwaceny.save()        // whole session -> WAV download
     __schwaceny.save('last')  // just the last turn
     __schwaceny.transcript()  // the tts_word text
     __schwaceny.clear()
   For a zero-interaction, auto-download-per-turn experience, use the Tampermonkey userscript
   in ../userscript/schwaceny.user.js instead (installs at document-start, no toggle needed). */
(() => {
  if (window.__schwacenyInstalled) { console.log('[schwaceny] already installed'); return; }
  window.__schwacenyInstalled = true;

  const Orig = window.WebSocket;
  const cap = window.__schwaceny = { chunks: [], words: [], text: '', turns: [0], sampleRate: 16000 };

  function assembleWav(byteArrays, sampleRate) {
    const total = byteArrays.reduce((a, b) => a + b.length, 0);
    const buf = new ArrayBuffer(44 + total), dv = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); dv.setUint32(4, 36 + total, true); wr(8, 'WAVE'); wr(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, total, true);
    let off = 44; for (const a of byteArrays) { new Uint8Array(buf, off, a.length).set(a); off += a.length; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  cap.save = (which = 'all') => {
    const arr = (which === 'last'
      ? cap.chunks.slice(cap.turns[cap.turns.length - 1])
      : cap.chunks).map(c => c.bytes);
    if (!arr.length) { console.warn('[schwaceny] no audio captured yet'); return; }
    const blob = assembleWav(arr, cap.sampleRate);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claude-voice-${which}-${Date.now()}.wav`;
    a.click();
    const secs = (arr.reduce((x, b) => x + b.length, 0) / (cap.sampleRate * 2)).toFixed(1);
    console.log(`[schwaceny] saved ${arr.length} frames (~${secs}s)`);
  };
  cap.transcript = () => cap.words.map(w => w.text).join('');
  cap.clear = () => { cap.chunks = []; cap.words = []; cap.text = ''; cap.turns = [0]; console.log('[schwaceny] cleared'); };

  class TappedWS extends Orig {
    constructor(url, protocols) {
      super(url, protocols);
      if (typeof url === 'string' && url.includes('/api/ws/voice/')) {
        console.log('[schwaceny] voice socket tapped:', url.slice(0, 90));
        this.addEventListener('message', (ev) => {
          const d = ev.data;
          if (d instanceof ArrayBuffer) {
            cap.chunks.push({ bytes: new Uint8Array(d.slice(0)), t: performance.now() });
          } else if (d instanceof Blob) {
            d.arrayBuffer().then(b => cap.chunks.push({ bytes: new Uint8Array(b), t: performance.now() }));
          } else if (typeof d === 'string') {
            let m; try { m = JSON.parse(d); } catch { return; }
            if (m.type === 'tts_word') cap.words.push({ text: m.text, pts: m.pts_ms });
            else if (m.type === 'message_sse') {
              const delta = m.event?.delta?.text ?? m.event?.data?.delta?.text;
              if (delta) cap.text += delta;
            } else if (m.type === 'turn_end' || m.type === 'conversation_ready') {
              cap.turns.push(cap.chunks.length); // mark a turn boundary for save('last')
            }
          }
        });
      }
    }
  }
  window.WebSocket = TappedWS;
  console.log('[schwaceny] installed. Toggle voice mode OFF then ON, speak, then run __schwaceny.save()');
})();
