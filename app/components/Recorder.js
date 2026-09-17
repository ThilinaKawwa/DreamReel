'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSession } from '@/lib/supabase';
import { STYLES, DEFAULT_STYLE } from '@/lib/styles';

const MAX_SECS = 30;
const BARS = 14;
const BAR_COLORS = ['#22d3ee', '#7c5cff', '#d946ef', '#7c5cff', '#22d3ee', '#f5b544', '#d946ef', '#7c5cff', '#22d3ee', '#7c5cff', '#d946ef', '#f5b544', '#22d3ee', '#7c5cff'];
const STEPS = ['Listening to your dream', 'Finding the scenes', 'Painting the pictures', 'Adding movement', 'Almost there'];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export default function Recorder() {
  const router = useRouter();
  const [phase, setPhase] = useState('idle'); // idle | recording | review | making
  const [secs, setSecs] = useState(0);
  const [text, setText] = useState('');
  const [live, setLive] = useState('');
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [levels, setLevels] = useState(Array(BARS).fill(0.15));
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const blobRef = useRef(null);
  const timerRef = useRef(null);
  const rafRef = useRef(null);
  const speechRef = useRef(null);
  const audioCtxRef = useRef(null);

  useEffect(() => {
    ensureSession().catch(() => {});
    try { const s = localStorage.getItem('dreamreel.style'); if (s && STYLES[s]) setStyle(s); } catch {}
    return () => stopEverything();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { try { localStorage.setItem('dreamreel.style', style); } catch {} }, [style]);

  function stopEverything() {
    clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    try { speechRef.current?.stop(); } catch {}
    try { audioCtxRef.current?.close(); } catch {}
  }

  async function startRecording() {
    setError(''); setLive(''); blobRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        blobRef.current = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        setPhase('review');
      };
      rec.start(250);
      recRef.current = rec;

      // Waveform from the microphone
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx(); audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 64; src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          an.getByteFrequencyData(buf);
          const out = [];
          for (let i = 0; i < BARS; i++) {
            const a = buf[Math.floor((i / BARS) * buf.length)] / 255;
            out.push(0.15 + a * 0.85);
          }
          setLevels(out);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {}

      // Live transcription preview (works in Chrome / Safari; the real transcript is done on the server)
      try {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
          const sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = 'en-GB';
          sr.onresult = (e) => { let s = ''; for (const r of e.results) s += r[0].transcript + ' '; setLive(s.trim()); };
          sr.start(); speechRef.current = sr;
        }
      } catch {}

      setSecs(0); setPhase('recording');
      timerRef.current = setInterval(() => {
        setSecs((s) => { if (s + 1 >= MAX_SECS) { stopRecording(); return MAX_SECS; } return s + 1; });
      }, 1000);
    } catch {
      setError("I couldn't use the microphone. Allow microphone access, or type your dream below instead.");
    }
  }

  function stopRecording() {
    stopEverything();
    setLevels(Array(BARS).fill(0.15));
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  async function submit() {
    const typed = text.trim();
    const blob = blobRef.current;
    if (!blob && typed.length < 8) return;
    setPhase('making'); setStep(0);
    const ticker = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 6000);
    try {
      const session = await ensureSession();
      const form = new FormData();
      form.append('style', style);
      if (blob) {
        const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
        form.append('audio', blob, `dream.${ext}`);
      } else form.append('text', typed);
      const res = await fetch('/api/dreams', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` }, body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      clearInterval(ticker);
      router.push(`/d/${data.id}?new=1`);
    } catch (e) {
      clearInterval(ticker);
      setError(e.message || 'Something went wrong.');
      setPhase(blob ? 'review' : 'idle');
    }
  }

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const recording = phase === 'recording';
  const hasAudio = phase === 'review';

  if (phase === 'making') {
    return (
      <main className="app">
        <div className="create-top"><span className="pill live"><i />Painting</span><span className="eyebrow">~30 s</span></div>
        <div className="making">
          <div className="orb" aria-hidden="true" />
          <div className="center">
            <h2>Painting last night…</h2>
            <p className="lead" style={{ marginTop: 8 }}>Keep this page open. It usually takes about half a minute.</p>
          </div>
          <div className="steps" aria-live="polite">
            {STEPS.map((label, i) => (
              <div key={label} className={`step ${i < step ? 'done' : i === step ? 'now' : ''}`}><i>{i < step ? '✓' : ''}</i>{label}</div>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app">
      <div className="create-top">
        <a href="/" className="iconbtn" aria-label="Close">✕</a>
        <span className={`pill ${recording ? 'live' : ''}`}><i />{recording ? 'Mic active · Listening' : hasAudio ? 'Recorded' : 'Mic ready'}</span>
        <span className="iconbtn" aria-hidden="true">◎</span>
      </div>

      <div className="center">
        <div className="eyebrow">Morning recording</div>
        <div className="timer-big grad-text" style={{ marginTop: 10 }}>{fmt(secs)}</div>
        <p className="lead" style={{ marginTop: 6 }}>
          {recording ? `${MAX_SECS - secs} seconds remaining` : hasAudio ? `${secs} seconds recorded` : 'Up to 30 seconds'}
        </p>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="wave" aria-hidden="true">
        {levels.map((l, i) => (
          <span key={i} style={{ height: `${Math.round(l * 120)}px`, background: BAR_COLORS[i] }} />
        ))}
      </div>

      <div className="row" style={{ display: 'flex', justifyContent: 'center' }}>
        {!hasAudio && (
          <button className={`btn ${recording ? '' : 'primary'}`} id="record" onClick={recording ? stopRecording : startRecording} style={{ minWidth: 200 }}>
            {recording ? '■ Stop' : '● Start recording'}
          </button>
        )}
        {hasAudio && (
          <button className="btn" id="rerecord" onClick={() => { blobRef.current = null; setSecs(0); setLive(''); setPhase('idle'); }}>↺ Record again</button>
        )}
      </div>

      <div className="transcript-box">
        <div className="head"><span>◍ {recording ? 'Live transcription' : hasAudio ? 'What we heard' : 'Or type your dream'}</span><b>{recording ? 'Auto-syncing' : ''}</b></div>
        {(recording || hasAudio) && (live || recording) ? (
          <p>{live ? `“…${live}”` : 'Listening…'}</p>
        ) : (
          <textarea
            id="typed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="…and then the clock tower turned completely into glass, floating above the tide. There were small glowing birds nesting in the hands…"
            aria-label="Type your dream"
          />
        )}
        {hasAudio && !live && <p className="lead" style={{ fontStyle: 'normal', fontSize: 13 }}>Your words will be written out when the reel is made.</p>}
      </div>

      <div>
        <div className="label">Choose dream visual style</div>
        <div className="styles" role="radiogroup" aria-label="Picture style" style={{ marginTop: 10 }}>
          {Object.entries(STYLES).map(([key, s]) => (
            <button key={key} id={`style-${key}`} role="radio" aria-checked={style === key} className={`style ${style === key ? 'on' : ''}`} onClick={() => setStyle(key)}>
              <b>{s.label}</b><small>{s.blurb}</small>
            </button>
          ))}
        </div>
      </div>

      <button className="btn primary block" id="make" onClick={submit} disabled={recording || (!hasAudio && text.trim().length < 8)}>
        ✦ Turn dream into reel
      </button>
    </main>
  );
}
