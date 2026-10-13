'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { GURU_NAME } from '@/lib/guru-public';

const MIN_SCENE_MS = 4500;
const SUMMARY_MS = 7500;
const W = 720, H = 1280;

/**
 * Plays a dream as a reel. Each scene shows its moving clip when there is one
 * (Premium) or its picture with a slow zoom and drift. With sound on, every
 * scene's narration plays over a soft ambient pad, and each scene lasts as long
 * as its narration. Premium owners get the Guru's summary as a final card.
 */
export default function Player({ scenes, date, autoplay = true, summary = null }) {
  const canvasRef = useRef(null);
  const [images, setImages] = useState(null);
  const [durations, setDurations] = useState(() => scenes.map(() => MIN_SCENE_MS));
  const [current, setCurrent] = useState(0);
  const [caption, setCaption] = useState('');
  const [capOn, setCapOn] = useState(false);
  const [playing, setPlaying] = useState(autoplay);
  const [sound, setSound] = useState(false);
  const [progress, setProgress] = useState(0);
  const stateRef = useRef({ t0: 0, paused: 0, pausedAt: 0, scene: -1 });
  const videosRef = useRef([]);
  const audiosRef = useRef([]);
  const padRef = useRef(null);

  const hasAudio = scenes.some((s) => s.audio_url);
  const slides = summary ? scenes.length + 1 : scenes.length;
  const timeline = useMemo(() => {
    const d = [...durations, ...(summary ? [SUMMARY_MS] : [])];
    const starts = [];
    let acc = 0;
    for (const x of d) { starts.push(acc); acc += x; }
    return { d, starts, total: acc };
  }, [durations, summary]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // Load pictures, clips and narration
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      scenes.map(
        (s) =>
          new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = s.image_url;
          })
      )
    ).then((imgs) => { if (!cancelled) setImages(imgs); });

    videosRef.current = scenes.map((s) => {
      if (!s.video_url) return null;
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', '');
      v.src = s.video_url;
      return v;
    });

    audiosRef.current = scenes.map((s, i) => {
      if (!s.audio_url) return null;
      const a = new Audio();
      a.preload = 'auto';
      a.src = s.audio_url;
      a.onloadedmetadata = () => {
        if (cancelled || !isFinite(a.duration)) return;
        setDurations((d) => d.map((x, k) => (k === i ? Math.max(MIN_SCENE_MS, a.duration * 1000 + 900) : x)));
      };
      return a;
    });

    return () => {
      cancelled = true;
      videosRef.current.forEach((v) => v && (v.pause(), v.removeAttribute('src'), v.load()));
      audiosRef.current.forEach((a) => a && a.pause());
    };
  }, [scenes]);

  // Stop the ambient pad when leaving the page
  useEffect(() => () => padRef.current?.stop(), []);

  // Draw loop
  useEffect(() => {
    if (!images) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf;
    const st = stateRef.current;
    if (!st.t0) st.t0 = performance.now();

    const draw = (now) => {
      if (!playing) return;
      const { d, starts, total } = timelineRef.current;
      const t = (now - st.t0 - st.paused) % total;
      let k = 0;
      while (k < d.length - 1 && t >= starts[k + 1]) k++;
      const local = t - starts[k];
      const p = local / d[k];

      if (k !== st.scene) {
        st.scene = k;
        onSceneStart(k, 0);
      }

      const isSummary = summary && k === scenes.length;
      const idx = isSummary ? scenes.length - 1 : k;
      const img = images[idx];
      const vid = videosRef.current[idx];

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (vid && vid.readyState >= 2 && !isSummary) {
        coverDraw(ctx, vid, vid.videoWidth, vid.videoHeight, 1, 0);
      } else if (img) {
        // cover-fit, then slow zoom + drift
        const zoom = reduce ? 1.04 : 1.04 + p * 0.1;
        const drift = reduce ? 0 : (k % 2 ? 1 : -1) * (p - 0.5) * 40;
        coverDraw(ctx, img, img.width, img.height, zoom, drift);
      } else {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#221a4f'); g.addColorStop(1, '#0b0a1f');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      if (isSummary) { ctx.fillStyle = 'rgba(8,6,20,.72)'; ctx.fillRect(0, 0, W, H); }
      // bottom shade so captions read
      const shade = ctx.createLinearGradient(0, H * 0.5, 0, H);
      shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,.7)');
      ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);
      // soft fade in at the start of each scene
      const fadeP = local / 600;
      if (fadeP < 1 && !reduce) { ctx.fillStyle = `rgba(0,0,0,${1 - fadeP})`; ctx.fillRect(0, 0, W, H); }

      setProgress(p);
      setCurrent(k);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, playing, sound, summary]);

  function coverDraw(ctx, src, sw, sh, zoom, drift) {
    if (!sw || !sh) return;
    const scale = Math.max(W / sw, H / sh) * zoom;
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, (W - dw) / 2 + drift, (H - dh) / 2, dw, dh);
  }

  /** Starts the clip and (with sound) the narration of scene k, `offset` ms in. */
  function onSceneStart(k, offset) {
    videosRef.current.forEach((v, i) => {
      if (!v) return;
      if (i === k) { v.currentTime = 0; v.play().catch(() => {}); } else v.pause();
    });
    audiosRef.current.forEach((a) => a && a.pause());
    const a = audiosRef.current[k];
    if (sound && a) {
      a.currentTime = Math.max(0, (offset - 300) / 1000);
      if (offset < 300) setTimeout(() => stateRef.current.scene === k && sound && a.play().catch(() => {}), 300 - offset);
      else if (a.currentTime < (a.duration || 99)) a.play().catch(() => {});
    }
    padRef.current?.setScene(k);
  }

  // Caption swap with a small fade
  useEffect(() => {
    setCapOn(false);
    const text = summary && current === scenes.length ? '' : scenes[current]?.caption || '';
    const id = setTimeout(() => { setCaption(text); setCapOn(true); }, 250);
    return () => clearTimeout(id);
  }, [current, scenes, summary]);

  function currentOffset() {
    const st = stateRef.current;
    const { starts, total } = timelineRef.current;
    const t = (performance.now() - st.t0 - st.paused) % total;
    return t - starts[Math.max(0, st.scene)];
  }

  function toggle() {
    const st = stateRef.current;
    if (playing) {
      st.pausedAt = performance.now();
      setPlaying(false);
      audiosRef.current.forEach((a) => a && a.pause());
      videosRef.current.forEach((v) => v && v.pause());
      padRef.current?.fade(0);
    } else {
      if (st.pausedAt) st.paused += performance.now() - st.pausedAt;
      st.pausedAt = 0;
      setPlaying(true);
      const k = Math.max(0, st.scene);
      videosRef.current[k]?.play().catch(() => {});
      if (sound) {
        const a = audiosRef.current[k];
        if (a && a.currentTime > 0 && !a.ended) a.play().catch(() => {});
        padRef.current?.fade(1);
      }
    }
  }

  function toggleSound(e) {
    e.stopPropagation();
    const next = !sound;
    setSound(next);
    if (next) {
      if (!padRef.current) padRef.current = createPad();
      padRef.current.fade(1);
      // play the current scene's words from where the picture is
      setTimeout(() => onSceneStartWithSound(), 0);
    } else {
      audiosRef.current.forEach((a) => a && a.pause());
      padRef.current?.fade(0);
    }
  }
  function onSceneStartWithSound() {
    const k = Math.max(0, stateRef.current.scene);
    const a = audiosRef.current[k];
    if (!a) return;
    const off = currentOffset();
    a.currentTime = Math.max(0, (off - 300) / 1000);
    if (a.currentTime < (a.duration || 99)) a.play().catch(() => {});
  }

  return (
    <div className="reel">
      <canvas ref={canvasRef} width={W} height={H} aria-label="Dream reel" />
      <button className="tap" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} id="reel-toggle" />
      <div className="wm">Dream Reel</div>
      <div className="date">{date}</div>
      <button className={`sound ${sound ? 'on' : ''}`} onClick={toggleSound} aria-pressed={sound} aria-label={sound ? 'Mute' : 'Play with sound'}>
        {sound ? '🔊' : hasAudio ? '🔈 Tap to hear it' : '🔈 Sound'}
      </button>
      {!images && <div className="paused">LOADING</div>}
      {images && !playing && <div className="paused">PAUSED</div>}
      <div className={`cap ${capOn ? 'on' : ''}`}>{caption}</div>
      {summary && (
        <div className={`summary-card ${current === scenes.length ? 'on' : ''}`} aria-hidden={current !== scenes.length}>
          <span className="eyebrow accent">✦ {GURU_NAME} sees</span>
          <p>{summary}</p>
        </div>
      )}
      <div className="bar">
        {Array.from({ length: slides }).map((_, i) => (
          <span key={i}><b style={{ width: i < current ? '100%' : i === current ? `${Math.min(1, progress) * 100}%` : '0%' }} /></span>
        ))}
      </div>
    </div>
  );
}

/**
 * A soft, slowly shifting ambient chord made in the browser — free music that
 * never clashes with the narration. One chord per scene.
 */
function createPad() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { fade() {}, setScene() {}, stop() {} };
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 900; filter.Q.value = 0.4;
  filter.connect(master); master.connect(ctx.destination);

  // slow "breathing" on the filter
  const lfo = ctx.createOscillator(); const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.07; lfoGain.gain.value = 350;
  lfo.connect(lfoGain); lfoGain.connect(filter.frequency); lfo.start();

  // dreamy chords (Hz): Dmaj9, Bm9, Gmaj7, A6sus, Em9
  const CHORDS = [
    [146.8, 220.0, 277.2, 329.6, 440.0],
    [123.5, 185.0, 220.0, 277.2, 370.0],
    [98.0, 196.0, 246.9, 293.7, 370.0],
    [110.0, 164.8, 246.9, 293.7, 370.0],
    [82.4, 164.8, 196.0, 246.9, 370.0],
  ];
  const voices = CHORDS[0].map((f, i) => {
    const o = ctx.createOscillator();
    o.type = i % 2 ? 'sine' : 'triangle';
    o.frequency.value = f;
    o.detune.value = (i - 2) * 4;
    const g = ctx.createGain(); g.gain.value = i === 0 ? 0.22 : 0.12;
    o.connect(g); g.connect(filter); o.start();
    return o;
  });
  return {
    fade(on) {
      if (ctx.state === 'suspended') ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(on ? 0.16 : 0, ctx.currentTime, on ? 1.2 : 0.3);
    },
    setScene(k) {
      const chord = CHORDS[k % CHORDS.length];
      voices.forEach((o, i) => o.frequency.setTargetAtTime(chord[i], ctx.currentTime, 1.5));
    },
    stop() { try { ctx.close(); } catch {} },
  };
}
