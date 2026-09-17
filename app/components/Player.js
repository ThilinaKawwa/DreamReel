'use client';

import { useEffect, useRef, useState } from 'react';

const SCENE_MS = 4500;
const W = 720, H = 1280;

/**
 * Plays a dream as a moving reel: each picture slowly zooms and drifts
 * (the "Ken Burns" effect), captions fade in, story-style progress bars on top.
 */
export default function Player({ scenes, date, autoplay = true }) {
  const canvasRef = useRef(null);
  const [images, setImages] = useState(null);
  const [current, setCurrent] = useState(0);
  const [caption, setCaption] = useState('');
  const [capOn, setCapOn] = useState(false);
  const [playing, setPlaying] = useState(autoplay);
  const [progress, setProgress] = useState(0);
  const stateRef = useRef({ t0: 0, paused: 0, pausedAt: 0 });

  // Load all pictures first
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
    return () => { cancelled = true; };
  }, [scenes]);

  // Draw loop
  useEffect(() => {
    if (!images) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = SCENE_MS * scenes.length;
    let raf;
    const st = stateRef.current;
    if (!st.t0) st.t0 = performance.now();

    const draw = (now) => {
      if (!playing) return;
      const t = (now - st.t0 - st.paused) % total;
      const k = Math.floor(t / SCENE_MS);
      const p = (t % SCENE_MS) / SCENE_MS;
      const img = images[k];

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (img) {
        // cover-fit, then slow zoom + drift
        const zoom = reduce ? 1.04 : 1.04 + p * 0.1;
        const drift = reduce ? 0 : (k % 2 ? 1 : -1) * (p - 0.5) * 40;
        const scale = Math.max(W / img.width, H / img.height) * zoom;
        const dw = img.width * scale, dh = img.height * scale;
        ctx.drawImage(img, (W - dw) / 2 + drift, (H - dh) / 2, dw, dh);
      } else {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#221a4f'); g.addColorStop(1, '#0b0a1f');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      // bottom shade so captions read
      const shade = ctx.createLinearGradient(0, H * 0.55, 0, H);
      shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,.65)');
      ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);
      // crossfade at the start of each scene
      if (p < 0.1 && !reduce) { ctx.fillStyle = `rgba(0,0,0,${1 - p / 0.1})`; ctx.fillRect(0, 0, W, H); }

      setProgress(p);
      if (k !== current) setCurrent(k);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, playing]);

  // Caption swap with a small fade
  useEffect(() => {
    setCapOn(false);
    const id = setTimeout(() => { setCaption(scenes[current]?.caption || ''); setCapOn(true); }, 250);
    return () => clearTimeout(id);
  }, [current, scenes]);

  function toggle() {
    const st = stateRef.current;
    if (playing) { st.pausedAt = performance.now(); setPlaying(false); }
    else { if (st.pausedAt) st.paused += performance.now() - st.pausedAt; setPlaying(true); }
  }

  return (
    <div className="reel">
      <canvas ref={canvasRef} width={W} height={H} aria-label="Dream reel" />
      <button className="tap" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} id="reel-toggle" />
      <div className="wm">Dream Reel</div>
      <div className="date">{date}</div>
      {!images && <div className="paused">LOADING</div>}
      {images && !playing && <div className="paused">PAUSED</div>}
      <div className={`cap ${capOn ? 'on' : ''}`}>{caption}</div>
      <div className="bar">
        {scenes.map((_, i) => (
          <span key={i}><b style={{ width: i < current ? '100%' : i === current ? `${progress * 100}%` : '0%' }} /></span>
        ))}
      </div>
    </div>
  );
}
