'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import OrinAvatar from '@/components/OrinAvatar';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { api, startPremium, pickMimeType } from '@/lib/api';
import { track } from '@/lib/analytics';
import { GURU_NAME } from '@/lib/guru-public';
import { expressionFor } from '@/lib/guru-expression';
import { textToVisemes, visemeAt } from '@/lib/visemes';
import { dreamDate } from '@/lib/profile';

const STATUS = {
  idle: 'Tap to speak',
  listening: 'Listening… tap when you’re done',
  thinking: `${GURU_NAME} is reflecting…`,
  speaking: 'Tap to stop',
  error: 'Something went quiet. Tap to try again.',
};
const CONVO_KEY = 'dreamreel.conversation';
const CONVO_HOURS = 6; // come back within this long and it's the same conversation

/** The small card under a dream: talk with Orin about it. */
export function GuruInvite({ dreamId }) {
  return (
    <a className="guru-invite" href={`/?dream=${dreamId}`}>
      <img className="guru-avatar" src="/orin-avatar-256.jpg" alt="" width={56} height={56} />
      <span><span className="eyebrow accent">Dream Guru</span><b>Talk to {GURU_NAME} about this dream</b></span>
      <span aria-hidden="true">→</span>
    </a>
  );
}

function savedConversation(dreamId) {
  try {
    const c = JSON.parse(localStorage.getItem(CONVO_KEY) || 'null');
    if (!c?.id || Date.now() - c.at > CONVO_HOURS * 3600e3) return null;
    if ((c.dreamId || null) !== (dreamId || null)) return null; // a specific dream has its own conversation
    return c;
  } catch { return null; }
}
function rememberConversation(c) {
  try { localStorage.setItem(CONVO_KEY, JSON.stringify({ ...c, at: Date.now() })); } catch {}
}

/**
 * Orin — the home of Dream Reel. One living portrait, one microphone, and a text mode that is
 * the SAME conversation (shared history, dream and memory). Voice: idle → listening →
 * processing → speaking → idle, with the mic ready again the moment he finishes.
 *
 * @param {{ dreamId?: string|null, greeting: string, dreamTitle?: string|null }} props
 */
export default function GuruScreen({ dreamId = null, greeting, dreamTitle = null }) {
  const [state, setState] = useState('idle');
  const [expression, setExpression] = useState('warm');
  const [caption, setCaption] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [currentDream, setCurrentDream] = useState(dreamId);
  const [savedNote, setSavedNote] = useState(null);   // { dreamId, first }
  const [results, setResults] = useState(null);       // search results [{id,title,date}]
  const [cited, setCited] = useState([]);
  const [offer, setOffer] = useState(null);           // { dreamId } — "Would you like me to visualize this dream?"
  const [visual, setVisual] = useState('');           // visualize progress words
  const [chatOpen, setChatOpen] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);               // { message, upgrade, canType }

  const levelRef = useRef(0);
  const visemeRef = useRef('rest');
  const speech = useRef(null);
  const audioCtx = useRef(null);
  const source = useRef(null);
  const rec = useRef(null);
  const meter = useRef(0);
  const endRef = useRef(null);

  // Resume today's conversation (same history in voice and text).
  useEffect(() => {
    let off = false;
    track('guru_opened', { about_dream: Boolean(dreamId) }, { onceKey: `guru-${dreamId || 'home'}` });
    const saved = savedConversation(dreamId);
    if (saved) {
      setConversationId(saved.id);
      if (saved.capturedDream) setCurrentDream(saved.capturedDream);
      (async () => {
        const session = await ensureSession();
        const { data } = await getBrowserSupabase().from('guru_messages').select('id, role, content, created_at')
          .eq('conversation_id', saved.id).eq('user_id', session.user.id).order('created_at', { ascending: true }).limit(60);
        if (!off && data) setMessages(data);
      })().catch(() => {});
    }
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
        cancelAnimationFrame(meter.current); levelRef.current = 0; setState('idle'); // mic is ready again at once
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
    setErr(null); setResults(null); setCited([]);
    setState('thinking');
    setExpression('thoughtful');
    const form = new FormData();
    if (conversationId) form.append('conversationId', conversationId);
    if (dreamId) form.append('dreamId', dreamId);
    if (audio) form.append('audio', audio, `speech.${audio.type.includes('mp4') ? 'm4a' : 'webm'}`);
    else form.append('text', question);
    if (voice) form.append('speak', '1');
    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', content: question || '🎙 …' }]);
    try {
      const d = await api('/api/guru/talk', { form });
      setConversationId(d.conversationId);
      setCurrentDream(d.dreamId);
      rememberConversation({ id: d.conversationId, dreamId: dreamId || null, capturedDream: d.dreamId || null });
      const expr = d.expression || expressionFor(d.answer);
      setMessages((m) => [...m.map((x) => (x.id === tempId ? { ...x, content: d.question } : x)), { id: d.messageId || `a-${Date.now()}`, role: 'assistant', content: d.answer }]);
      setCaption(d.answer);
      if (d.newDream) setSavedNote({ dreamId: d.dreamId });
      if (d.results) setResults(d.results);
      if (d.cited?.length) setCited(d.cited);
      if (d.offerVisualize || d.action?.type === 'confirm_visualize') setOffer({ dreamId: d.dreamId });
      if (d.audio) {
        const bin = Uint8Array.from(atob(d.audio), (c) => c.charCodeAt(0));
        await play(bin.buffer, expr, d.answer);
      } else {
        setExpression(expr);
        setState('idle');
      }
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setErr({ message: e.message, upgrade: e.upgrade, canType: e.status === 402 || e.status === 400 || e.status === 429 });
      setExpression('concerned');
      setState('error');
      if (question) setText((t) => t || question); // never lose what they typed
    }
  }

  async function onMic() {
    if (state === 'speaking') { stopAll(); setState('idle'); return; }
    if (state === 'thinking') return;
    if (state === 'listening') { rec.current?.stop(); return; }
    setErr(null);
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
      r.limit = setTimeout(() => r.state === 'recording' && r.stop(), 120000); // dreams can take a while to tell
      rec.current = r;
      r.start();
      setState('listening');
      setExpression('curious');
    } catch {
      setErr({ message: `Allow the microphone to talk with ${GURU_NAME} — or type instead.`, canType: true });
      setState('error');
    }
  }

  function openChat() { setChatOpen(true); track('guru_text_opened'); track('guru_chat_mode_opened'); }
  function send(e) {
    e.preventDefault();
    const q = text.trim();
    if (!q || state === 'thinking') return;
    setText('');
    stopAll();
    ask({ question: q, voice: false });
  }

  function newDream() {
    stopAll();
    try { localStorage.removeItem(CONVO_KEY); } catch {}
    if (dreamId) { window.location.href = '/'; return; }
    setConversationId(null); setCurrentDream(null); setMessages([]); setCaption(''); setSavedNote(null);
    setResults(null); setCited([]); setOffer(null); setVisual(''); setErr(null); setState('idle'); setExpression('warm');
  }

  async function visualize() {
    const id = offer?.dreamId;
    if (!id) return;
    setVisual('Starting…');
    try {
      const r = await api(`/api/dreams/${id}/visualize`, { json: {} });
      setOffer(null);
      setVisual(r.status === 'exists' ? 'This dream already has a Dream Reel.' : 'Your Dream Reel is being made. It will appear with this dream.');
    } catch (e) {
      setVisual('');
      setErr({ message: e.message, upgrade: e.upgrade });
    }
  }

  async function upgrade() {
    track('upgrade_clicked', { from: 'guru' });
    try { await startPremium(); } catch (e) { setErr({ message: e.message }); }
  }

  const status = err?.message || STATUS[state];

  return (
    <main className="guru-home">
      <div className="guru-top">
        <span className="brand-mark">Dream Reel</span>
        {dreamTitle && <span className="eyebrow accent guru-about">{dreamTitle}</span>}
        {(currentDream || messages.length > 0) && <button className="linkbtn small" onClick={newDream}>New dream</button>}
      </div>

      <OrinAvatar state={state} expression={expression} levelRef={levelRef} visemeRef={visemeRef} />

      <div className="guru-caption" aria-live="polite">
        {caption ? <p>{caption}</p> : <p className="guru-greeting">{greeting}</p>}
        {savedNote && (
          <a className="saved-note" href={`/d/${savedNote.dreamId}`}>✓ Saved to My Dreams</a>
        )}
        {results && (
          results.length ? (
            <ul className="result-list" aria-label="Matching dreams">
              {results.map((r) => <li key={r.id}><a href={`/d/${r.id}`}>{r.title}</a><span>{r.date ? dreamDate(r.date) : ''}</span></li>)}
            </ul>
          ) : null
        )}
        {!results && cited.length > 0 && (
          <div className="cited">{cited.map((c) => <a key={c.id} href={`/d/${c.id}`} onClick={() => track('related_dream_opened', { from: 'guru' })}>{c.title}</a>)}</div>
        )}
        {offer && (
          <div className="visualize-offer">
            <span>Would you like me to visualize this dream?</span>
            <div><button className="btn primary small" onClick={visualize}>Visualize this dream</button><button className="linkbtn small" onClick={() => setOffer(null)}>Not now</button></div>
          </div>
        )}
        {visual && <p className="fine">{visual}</p>}
      </div>

      <div className="guru-controls">
        <button
          className={`mic ${state}`}
          onClick={onMic}
          disabled={state === 'thinking'}
          aria-label={state === 'listening' ? 'Stop and send' : state === 'speaking' ? `Stop ${GURU_NAME}` : `Talk to ${GURU_NAME}`}
          aria-pressed={state === 'listening'}
        >
          {state === 'listening' ? '■' : state === 'speaking' ? '❚❚' : <MicIcon />}
        </button>
        <div className="guru-status" role="status">{status}</div>
        {err?.upgrade && <button className="btn primary small" onClick={upgrade}>See Premium</button>}
        <button className="linkbtn" onClick={openChat}>Prefer to type?</button>
      </div>

      <nav className="guru-more" aria-label="Your dream world">
        <a href="/dreams">My Dreams</a>
        <a href="/gallery">Visual Memories</a>
        <a href="/insights">Insights</a>
      </nav>
      <p className="fine">{GURU_NAME} is an AI companion for reflection — not a therapist, psychic or prediction of real events.</p>

      {chatOpen && (
        <div className="guru-sheet" role="dialog" aria-label={`Chat with ${GURU_NAME}`}>
          <div className="sheet-head">
            <b>{GURU_NAME}</b>
            <button className="linkbtn small" onClick={() => setChatOpen(false)}>Use voice</button>
          </div>
          <div className="chat">
            {messages.length === 0 && <div className="msg-row assistant"><div className="msg assistant">{greeting}</div></div>}
            {messages.map((m) => (
              <div key={m.id} className={`msg-row ${m.role}`}><div className={`msg ${m.role}`}>{m.content}</div></div>
            ))}
            {state === 'thinking' && <div className="msg-row assistant"><div className="msg assistant thinking">{GURU_NAME} is reflecting<span className="dots" /></div></div>}
            <div ref={endRef} />
          </div>
          {err?.message && <div className="error">{err.message}</div>}
          <form className="ask" onSubmit={send}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What do you remember?" maxLength={4000} aria-label={`Write to ${GURU_NAME}`}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }} />
            <button className="send" type="submit" disabled={!text.trim() || state === 'thinking'} aria-label="Send">➤</button>
          </form>
        </div>
      )}
    </main>
  );
}

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>
);
