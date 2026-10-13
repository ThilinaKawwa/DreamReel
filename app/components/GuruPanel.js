'use client';

import { useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase';
import { api, startPremium, pickMimeType, playAudio } from '@/lib/api';
import { GURU_NAME, PREMIUM_PRICE_LABEL } from '@/lib/guru-public';

const STARTERS = [
  'What is this dream really about?',
  'Why did I dream this now?',
  'What should I watch for in the coming days?',
  'Which symbol matters most?',
];

/**
 * The Dream Guru under a reel (owner only).
 * Free: an invitation to unlock. Premium: the reading, then a conversation by text or voice.
 */
export default function GuruPanel({ dream, premium, reading, onReading }) {
  if (premium === null) return null; // still checking the plan
  if (!premium) return <Invite />;
  return <Guru dream={dream} reading={reading} onReading={onReading} />;
}

function Invite() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await startPremium(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <section className="guru invite" aria-labelledby="guru-invite">
      <div className="guru-head">
        <span className="guru-avatar" aria-hidden="true">☾</span>
        <div>
          <div className="eyebrow accent">The Dream Guru</div>
          <h3 id="guru-invite">{GURU_NAME} is waiting to read this dream</h3>
        </div>
      </div>
      <ul className="perks">
        <li><b>Why you dreamed it</b> — psychology meets the world's great dream traditions</li>
        <li><b>Talk it through</b> — ask {GURU_NAME} anything, by voice or text</li>
        <li><b>He remembers</b> — spots the patterns running through your dreams</li>
        <li><b>Moving reels</b> — every scene comes alive as real video</li>
      </ul>
      {err && <div className="error">{err}</div>}
      <button className="btn primary block" onClick={go} disabled={busy}>
        {busy ? 'Opening…' : `✦ Unlock Premium · ${PREMIUM_PRICE_LABEL}`}
      </button>
      <p className="fine">Cancel any time. For reflection and enjoyment — not fortune-telling or professional advice.</p>
    </section>
  );
}

function Guru({ dream, reading, onReading }) {
  const [err, setErr] = useState('');
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const audioRef = useRef(null);
  const recRef = useRef(null);
  const endRef = useRef(null);
  const askedForReading = useRef(false);
  const [attempt, setAttempt] = useState(0);

  // First reading (made once, then kept)
  useEffect(() => {
    if (reading || askedForReading.current) return;
    askedForReading.current = true;
    api('/api/guru/reading', { json: { dreamId: dream.id } })
      .then((d) => onReading(d.reading))
      .catch((e) => setErr(e.message));
  }, [reading, dream.id, onReading, attempt]);

  function retryReading() { askedForReading.current = false; setErr(''); setAttempt((n) => n + 1); }

  // Earlier conversation about this dream
  useEffect(() => {
    getBrowserSupabase()
      .from('guru_messages')
      .select('id, role, content, created_at')
      .eq('dream_id', dream.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => data && setMessages(data));
  }, [dream.id]);

  // Follow the conversation only after they've asked something (not on page load).
  const follow = useRef(false);
  useEffect(() => {
    if (follow.current) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, thinking]);
  useEffect(() => () => { audioRef.current?.pause(); recRef.current?.stream?.getTracks().forEach((t) => t.stop()); }, []);

  function stopVoice() { audioRef.current?.pause(); audioRef.current = null; setSpeakingId(null); }

  async function hear(id, body) {
    if (speakingId === id) return stopVoice();
    stopVoice();
    setSpeakingId(id);
    try {
      const blob = await api('/api/guru/speak', { json: body });
      const a = playAudio(blob);
      a.onended = () => setSpeakingId(null);
      audioRef.current = a;
    } catch (e) { setErr(e.message); setSpeakingId(null); }
  }

  async function ask({ question, audio }) {
    if (thinking) return;
    setErr(''); stopVoice();
    follow.current = true;
    const form = new FormData();
    form.append('dreamId', dream.id);
    if (audio) form.append('audio', audio, `question.${audio.type.includes('mp4') ? 'm4a' : 'webm'}`);
    else form.append('text', question);
    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', content: question || '🎙 …' }]);
    setThinking(true);
    try {
      const d = await api('/api/guru/chat', { form });
      const replyId = d.messageId || `a-${Date.now()}`;
      setMessages((m) => [
        ...m.map((x) => (x.id === tempId ? { ...x, content: d.question } : x)),
        { id: replyId, role: 'assistant', content: d.answer },
      ]);
      if (d.audio) {
        const a = playAudio(d.audio);
        setSpeakingId(replyId);
        a.onended = () => setSpeakingId(null);
        audioRef.current = a;
      }
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setErr(e.message);
    } finally {
      setThinking(false);
    }
  }

  function send(e) {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    setText('');
    ask({ question: q });
  }

  async function toggleMic() {
    if (recording) { recRef.current?.stop(); return; }
    if (thinking) return;
    setErr(''); stopVoice();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(rec.limit);
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 2000) ask({ audio: blob });
      };
      rec.stream = stream;
      rec.limit = setTimeout(() => rec.state === 'recording' && rec.stop(), 60000);
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setErr('Allow the microphone to talk with the Guru — or type your question.');
    }
  }

  return (
    <section className="guru" aria-labelledby="guru-title">
      <div className="guru-head">
        <span className="guru-avatar" aria-hidden="true">☾</span>
        <div>
          <div className="eyebrow accent">The Dream Guru</div>
          <h3 id="guru-title">{GURU_NAME}'s reading</h3>
        </div>
        {reading && (
          <button className="iconbtn hear" onClick={() => hear('reading', { dreamId: dream.id })} aria-label={speakingId === 'reading' ? 'Stop' : `Hear ${GURU_NAME} read it`}>
            {speakingId === 'reading' ? '■' : '▶'}
          </button>
        )}
      </div>

      {!reading && !err && (
        <div className="guru-wait"><span className="orb small" aria-hidden="true" /> {GURU_NAME} is reading your dream…</div>
      )}
      {reading && <div className="reading"><Markdown text={reading.reading} /></div>}
      {reading?.symbols?.length > 0 && (
        <div className="tags">{reading.symbols.map((s) => <span key={s}>{s}</span>)}</div>
      )}

      {reading && (
        <>
          <div className="chat" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <Markdown text={m.content} />
                {m.role === 'assistant' && !String(m.id).startsWith('a-') && (
                  <button className="msg-hear" onClick={() => hear(m.id, { messageId: m.id })} aria-label={speakingId === m.id ? 'Stop' : 'Hear this'}>
                    {speakingId === m.id ? '■ Stop' : '▶ Hear'}
                  </button>
                )}
              </div>
            ))}
            {thinking && <div className="msg assistant thinking">{GURU_NAME} is reflecting<span className="dots" /></div>}
            <div ref={endRef} />
          </div>

          {messages.length === 0 && !thinking && (
            <div className="starters">
              {STARTERS.map((s) => <button key={s} className="chip" onClick={() => ask({ question: s })}>{s}</button>)}
            </div>
          )}

          <form className="ask" onSubmit={send}>
            <button
              type="button"
              className={`talk ${recording ? 'live' : ''}`}
              onClick={toggleMic}
              aria-pressed={recording}
              aria-label={recording ? 'Stop and send' : `Tap to talk to ${GURU_NAME}`}
              disabled={thinking}
            >
              {recording ? '■' : '🎙'}
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={recording ? 'Listening… tap ■ when done' : `Ask ${GURU_NAME} about your dream`}
              maxLength={1500}
              disabled={recording}
              aria-label={`Ask ${GURU_NAME}`}
            />
            <button className="send" type="submit" disabled={!text.trim() || thinking} aria-label="Send">➤</button>
          </form>
        </>
      )}

      {err && <div className="error">{err}</div>}
      {err && !reading && <button className="btn block" onClick={retryReading}>Try again</button>}
      <p className="fine">{GURU_NAME} is an AI guide for reflection — not a prediction of real events or professional advice.</p>
    </section>
  );
}

/** Tiny, safe markdown: ### headings, - bullets, **bold**, *italic*. */
function Markdown({ text }) {
  const blocks = [];
  let list = null;
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (/^[-•*]\s+/.test(line)) {
      list = list || [];
      list.push(<li key={i}>{inline(line.replace(/^[-•*]\s+/, ''))}</li>);
      return;
    }
    if (list) { blocks.push(<ul key={`l${i}`}>{list}</ul>); list = null; }
    if (!line) return;
    if (/^#{1,6}\s/.test(line)) blocks.push(<h4 key={i}>{inline(line.replace(/^#+\s*/, ''))}</h4>);
    else blocks.push(<p key={i}>{inline(line)}</p>);
  });
  if (list) blocks.push(<ul key="lend">{list}</ul>);
  return <>{blocks}</>;
}

function inline(s) {
  return s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^(\*[^*]+\*|_[^_]+_)$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}
