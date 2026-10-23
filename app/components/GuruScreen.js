'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import OrinAvatar from '@/components/OrinAvatar';
import { getBrowserSupabase } from '@/lib/supabase';
import { api, startPremium, pickMimeType } from '@/lib/api';
import { track } from '@/lib/analytics';
import { GURU_NAME } from '@/lib/guru-public';
import { expressionFor } from '@/lib/guru-expression';
import { textToVisemes, visemeAt } from '@/lib/visemes';

const STATUS = {
  idle: 'Tap to talk',
  listening: 'Listening… tap when you’re done',
  thinking: `${GURU_NAME} is reflecting…`,
  speaking: 'Tap to interrupt',
  error: 'Something went quiet. Tap to try again.',
};

/** The small card under a dream: opens the Guru, or shows a tasteful locked state. */
export function GuruInvite({ dreamId, access }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (access.canUseGuru) {
    return (
      <a className="guru-invite" href={`/d/${dreamId}/guru`}>
        <img className="guru-avatar" src="/orin-avatar-256.jpg" alt="" width={56} height={56} />
        <span><span className="eyebrow accent">Dream Guru</span><b>Talk with {GURU_NAME} about this dream</b></span>
        <span aria-hidden="true">→</span>
      </a>
    );
  }
  async function unlock() {
    track('upgrade_clicked', { from: 'guru' });
    setBusy(true); setErr('');
    try { await startPremium(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <section className="guru-invite locked" aria-label="Dream Guru (locked)">
      <img className="guru-avatar" src="/orin-avatar-256.jpg" alt="" width={56} height={56} />
      <span>
        <span className="eyebrow accent">Dream Guru · Premium</span>
        <b>{GURU_NAME} can talk this dream through with you</b>
        <small>A calm conversation, by voice or text. For reflection, not prediction.</small>
      </span>
      {access.upgradeAvailable
        ? <button className="btn primary block" onClick={unlock} disabled={busy}>{busy ? 'Opening…' : 'Unlock Dream Guru'}</button>
        : <p className="fine">Premium isn’t open yet — {GURU_NAME} is coming soon.</p>}
      {err && <div className="error">{err}</div>}
    </section>
  );
}

/** The immersive Guru: a living portrait, one mic button, and an optional text chat. */
export default function GuruScreen({ dreamId }) {
  const [access, setAccess] = useState(null);
  const [dream, setDream] = useState(null);
  const [state, setState] = useState('idle');
  const [expression, setExpression] = useState('warm');
  const [caption, setCaption] = useState('');
  const [messages, setMessages] = useState([]);
  const [reading, setReading] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  const levelRef = useRef(0);
  const visemeRef = useRef('rest');
  const speech = useRef(null); // { track, startAt } for approximate viseme sync
  const audioCtx = useRef(null);
  const source = useRef(null);
  const rec = useRef(null);
  const meter = useRef(0);
  const endRef = useRef(null);

  useEffect(() => {
    let off = false;
    (async () => {
      const a = await api('/api/me/entitlements', { method: 'GET' }).catch(() => null);
      if (off) return;
      setAccess(a || { canUseGuru: false });
      if (!a?.canUseGuru) return;
      track('guru_opened', {}, { onceKey: `guru-${dreamId}` });
      const supabase = getBrowserSupabase();
      const [{ data: d }, { data: m }] = await Promise.all([
        supabase.from('dreams').select('id, title, status').eq('id', dreamId).maybeSingle(),
        supabase.from('guru_messages').select('id, role, content, created_at').eq('dream_id', dreamId).order('created_at', { ascending: true }),
      ]);
      if (off) return;
      setDream(d || false);
      if (m) setMessages(m);
      if (d) {
        api('/api/guru/reading', { json: { dreamId } })
          .then((r) => { if (!off) { setReading(r.reading); setCaption(r.reading?.summary || ''); setExpression('warm'); } })
          .catch((e) => !off && setErr(e.message));
      }
    })();
    return () => { off = true; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dreamId]);

  useEffect(() => { if (chatOpen) endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, chatOpen]);

  // One audio engine for everything; created on the first tap (browsers require a gesture).
  function engine() {
    if (!audioCtx.current) audioCtx.current = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.current.state === 'suspended') audioCtx.current.resume();
    return audioCtx.current;
  }

  function followLevel(analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    cancelAnimationFrame(meter.current);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      levelRef.current = Math.max(0, Math.min(1, (rms - 0.015) * 5));
      if (speech.current && audioCtx.current) visemeRef.current = visemeAt(speech.current.track, audioCtx.current.currentTime - speech.current.startAt);
      meter.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopAll() {
    try { source.current?.stop(); } catch {}
    source.current = null;
    cancelAnimationFrame(meter.current);
    levelRef.current = 0;
    speech.current = null;
    visemeRef.current = 'rest';
    if (rec.current?.state === 'recording') { rec.current.onstop = null; rec.current.stop(); }
    rec.current?.stream?.getTracks().forEach((t) => t.stop());
  }

  const play = useCallback(async (bytes, expr, spokenText) => {
    const ctx = engine();
    const audio = await ctx.decodeAudioData(bytes);
    try { source.current?.stop(); } catch {}
    const node = ctx.createBufferSource();
    node.buffer = audio;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    node.onended = () => {
      if (source.current === node) {
        source.current = null; speech.current = null; visemeRef.current = 'rest';
        cancelAnimationFrame(meter.current); levelRef.current = 0; setState('idle');
      }
    };
    source.current = node;
    if (expr) setExpression(expr);
    setState('speaking');
    speech.current = { track: textToVisemes(spokenText || '', audio.duration), startAt: ctx.currentTime + 0.02 };
    followLevel(analyser);
    node.start(ctx.currentTime + 0.02);
  }, []);

  async function ask({ question, audio, voice }) {
    setErr('');
    setState('thinking');
    setExpression('thoughtful');
    const form = new FormData();
    form.append('dreamId', dreamId);
    if (audio) form.append('audio', audio, `question.${audio.type.includes('mp4') ? 'm4a' : 'webm'}`);
    else form.append('text', question);
    if (voice) form.append('speak', '1');
    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', content: question || '🎙 …' }]);
    try {
      const d = await api('/api/guru/chat', { form });
      const expr = d.expression || expressionFor(d.answer);
      setMessages((m) => [...m.map((x) => (x.id === tempId ? { ...x, content: d.question } : x)), { id: d.messageId || `a-${Date.now()}`, role: 'assistant', content: d.answer }]);
      setCaption(d.answer);
      if (d.audio) {
        const bin = Uint8Array.from(atob(d.audio), (c) => c.charCodeAt(0));
        await play(bin.buffer, expr, d.answer);
      } else {
        setExpression(expr);
        setState('idle');
      }
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setErr(e.message);
      setExpression('concerned');
      setState('error');
    }
  }

  async function onMic() {
    if (state === 'speaking') { stopAll(); setState('idle'); return; }
    if (state === 'thinking') return;
    if (state === 'listening') { rec.current?.stop(); return; }
    setErr('');
    const ctx = engine();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      followLevel(analyser);
      const mimeType = pickMimeType();
      const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      r.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(r.limit);
        cancelAnimationFrame(meter.current);
        levelRef.current = 0;
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        if (blob.size > 2000) ask({ audio: blob, voice: true });
        else setState('idle');
      };
      r.stream = stream;
      r.limit = setTimeout(() => r.state === 'recording' && r.stop(), 60000);
      rec.current = r;
      r.start();
      setState('listening');
      setExpression('curious');
    } catch {
      setErr(`Allow the microphone to talk with ${GURU_NAME} — or type instead.`);
      setState('error');
    }
  }

  async function hearReading() {
    if (state === 'speaking') { stopAll(); setState('idle'); return; }
    engine();
    setState('thinking');
    try {
      const blob = await api('/api/guru/speak', { json: { dreamId } });
      await play(await blob.arrayBuffer(), 'warm', reading?.reading || '');
    } catch (e) { setErr(e.message); setState('error'); }
  }

  function openChat() { setChatOpen(true); track('guru_chat_mode_opened'); }
  function send(e) {
    e.preventDefault();
    const q = text.trim();
    if (!q || state === 'thinking') return;
    setText('');
    stopAll();
    ask({ question: q, voice: false });
  }

  if (!access) return <main className="guru-screen"><p className="lead center">Opening…</p></main>;
  if (!access.canUseGuru) {
    return (
      <main className="guru-screen">
        <div className="create-top"><a href={`/d/${dreamId}`} className="iconbtn" aria-label="Back">←</a></div>
        <div className="guru-portrait locked"><img src="/orin.jpg" alt={`${GURU_NAME}, the Dream Guru`} width={900} height={1117} /></div>
        <GuruInvite dreamId={dreamId} access={access} />
      </main>
    );
  }
  if (dream === false) {
    return <main className="guru-screen"><div className="empty"><h2>This dream isn’t here</h2><a className="btn primary" href="/gallery">Your dreams</a></div></main>;
  }

  return (
    <main className="guru-screen">
      <div className="create-top">
        <a href={`/d/${dreamId}`} className="iconbtn" aria-label="Back to the dream">←</a>
        <span className="eyebrow accent">{dream?.title || 'Dream Guru'}</span>
        <span className="iconbtn" aria-hidden="true" style={{ visibility: 'hidden' }} />
      </div>

      <OrinAvatar state={state} expression={expression} levelRef={levelRef} visemeRef={visemeRef} />

      <div className="guru-caption" aria-live="polite">
        {caption ? <p>{caption}</p> : <p className="muted">{reading === null && !err ? `${GURU_NAME} is reading your dream…` : ''}</p>}
        {reading && state !== 'speaking' && (
          <button className="linkbtn" onClick={hearReading}>▶ Hear {GURU_NAME}’s reading</button>
        )}
      </div>

      <div className="guru-controls">
        <button
          className={`mic ${state}`}
          onClick={onMic}
          disabled={state === 'thinking' || (!reading && !err)}
          aria-label={state === 'listening' ? 'Stop and send' : state === 'speaking' ? `Stop ${GURU_NAME}` : `Talk to ${GURU_NAME}`}
          aria-pressed={state === 'listening'}
        >
          {state === 'listening' ? '■' : state === 'speaking' ? '❚❚' : '🎙'}
        </button>
        <div className="guru-status" role="status">{err || STATUS[state]}</div>
        <button className="linkbtn" onClick={openChat}>Prefer to type?</button>
      </div>
      <p className="fine">{GURU_NAME} is an AI guide for reflection — not a psychic, therapist or prediction of real events.</p>

      {chatOpen && (
        <div className="guru-sheet" role="dialog" aria-label={`Chat with ${GURU_NAME}`}>
          <div className="sheet-head">
            <b>Chat with {GURU_NAME}</b>
            <button className="iconbtn" onClick={() => setChatOpen(false)} aria-label="Close chat">×</button>
          </div>
          <div className="chat">
            {messages.map((m) => (
              <div key={m.id} className={`msg-row ${m.role}`}><div className={`msg ${m.role}`}>{m.content}</div></div>
            ))}
            {state === 'thinking' && <div className="msg-row assistant"><div className="msg assistant thinking">{GURU_NAME} is reflecting<span className="dots" /></div></div>}
            <div ref={endRef} />
          </div>
          <form className="ask" onSubmit={send}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${GURU_NAME} about your dream`} maxLength={1500} aria-label={`Ask ${GURU_NAME}`} />
            <button className="send" type="submit" disabled={!text.trim() || state === 'thinking'} aria-label="Send">➤</button>
          </form>
        </div>
      )}
    </main>
  );
}
