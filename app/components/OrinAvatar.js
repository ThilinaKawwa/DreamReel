'use client';

import { useEffect, useRef } from 'react';
import { GURU_NAME } from '@/lib/guru-public';

// Orin, brought to life in the browser from his one approved portrait (public/orin.jpg).
// Everything is drawn on a canvas each frame: breathing, blinking, brows, a small head
// tilt, and a jaw that opens with the loudness of his voice. No video model, no extra
// cost per reply, and he can never drift into a different face.
//
// Landmarks are in the portrait's own pixels (900 × 1117).
const SRC = { w: 900, h: 1117 };
const CROP = { x: 150, y: 150, w: 600, h: 760 }; // face and shoulders
const EYES = [{ x: 378, y: 408 }, { x: 522, y: 405 }];
const EYE = { rx: 31, ry: 12 };
const MOUTH = { x: 452, y: 577, rx: 42 };
const BEARD = { x: 452, y: 720, rx: 165, ry: 175 };
const BROWS = { x: 455, y: 368, rx: 150, ry: 34 };

// How each expression nudges the face. Small on purpose: same Orin, different mood.
const LOOKS = {
  neutral: { brow: 0, lid: 0.06, tilt: 0, tint: null },
  warm: { brow: 1, lid: 0.18, tilt: -0.008, tint: 'rgba(245,181,68,0.10)' },
  curious: { brow: 4, lid: 0, tilt: 0.018, tint: 'rgba(34,211,238,0.06)' },
  thoughtful: { brow: -1.5, lid: 0.28, tilt: -0.014, tint: 'rgba(124,92,255,0.10)' },
  concerned: { brow: 2.5, lid: 0.16, tilt: 0.01, tint: 'rgba(90,120,255,0.10)' },
  amused: { brow: 2, lid: 0.3, tilt: -0.012, tint: 'rgba(245,181,68,0.12)' },
  surprised: { brow: 6, lid: -0.05, tilt: 0, tint: 'rgba(255,255,255,0.05)' },
};

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {{ state: 'idle'|'listening'|'thinking'|'speaking'|'error', expression: string,
 *           levelRef: import('react').MutableRefObject<number> }} props
 *   levelRef.current is the live loudness (0–1) of Orin's voice while speaking,
 *   or of the person's voice while listening.
 */
export default function OrinAvatar({ state, expression = 'neutral', levelRef }) {
  const canvasRef = useRef(null);
  const live = useRef({ state, expression });
  live.current = { state, expression };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.src = '/orin.jpg';
    let raf = 0;
    let skin = 'rgb(150,95,65)';
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const f = { brow: 0, lid: 0.06, tilt: 0, jaw: 0, blink: 0, tintA: 0 };
    let nextBlink = performance.now() + 2500;
    let blinkStart = 0;

    function size() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.width * (CROP.h / CROP.w) * dpr);
    }

    function sampleSkin() {
      // Eyelid colour = the skin just above each eye, so blinks match his face.
      try {
        const c = document.createElement('canvas');
        c.width = SRC.w; c.height = SRC.h;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const d = x.getImageData(EYES[0].x - 10, EYES[0].y - 26, 20, 8).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        skin = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
      } catch {}
    }

    function shifted(clip, dy) {
      // Redraws one soft-edged region of the portrait moved up/down by dy pixels.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(clip.x, clip.y, clip.rx, clip.ry, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 0, dy);
      ctx.restore();
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!img.complete || !canvas.width) return;
      const { state: st, expression: ex } = live.current;
      const look = LOOKS[ex] || LOOKS.neutral;
      const level = Math.max(0, Math.min(1, levelRef?.current || 0));

      // Ease every feature towards its target so nothing snaps.
      const thinking = st === 'thinking';
      f.brow = lerp(f.brow, thinking ? -1 : look.brow, 0.06);
      f.lid = lerp(f.lid, thinking ? 0.32 : st === 'listening' ? 0 : look.lid, 0.06);
      f.tilt = lerp(f.tilt, st === 'listening' ? 0.02 : look.tilt, 0.04);
      f.jaw = lerp(f.jaw, st === 'speaking' ? Math.min(1, level * 1.6) : 0, 0.45);
      f.tintA = lerp(f.tintA, look.tint ? 1 : 0, 0.05);

      if (now > nextBlink && !blinkStart) blinkStart = now;
      if (blinkStart) {
        const t = (now - blinkStart) / 170;
        f.blink = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
        if (t >= 1) { blinkStart = 0; f.blink = 0; nextBlink = now + 2600 + Math.random() * 3800; }
      }

      const s = canvas.width / CROP.w;
      const breathe = reduced ? 0 : Math.sin(now / 1400) * 0.006;
      const lean = st === 'listening' ? 0.015 : 0;
      const zoom = 1 + breathe + lean;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0a0814';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Pivot at the chest so breathing and tilt look like a body, not a picture.
      const px = (MOUTH.x - CROP.x) * s;
      const py = canvas.height * 0.95;
      ctx.translate(px, py);
      ctx.rotate(reduced ? 0 : f.tilt + Math.sin(now / 3100) * 0.003);
      ctx.scale(zoom, zoom);
      ctx.translate(-px, -py);
      ctx.transform(s, 0, 0, s, -CROP.x * s, -CROP.y * s);

      ctx.drawImage(img, 0, 0);

      // Brows
      if (Math.abs(f.brow) > 0.2) shifted(BROWS, -f.brow);

      // Jaw: a dark mouth opening, with the beard redrawn lower over it.
      const open = f.jaw * 9;
      if (open > 0.3) {
        ctx.fillStyle = '#1d0d08';
        ctx.beginPath();
        ctx.ellipse(MOUTH.x, MOUTH.y + open / 2, MOUTH.rx * (0.75 + f.jaw * 0.2), open / 2 + 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, MOUTH.y + 1, SRC.w, SRC.h);
        ctx.clip();
        shifted(BEARD, open);
        ctx.restore();
      }

      // Eyelids (expression + blink)
      const lid = Math.max(0, Math.min(1, f.lid + f.blink));
      if (lid > 0.02) {
        for (const e of EYES) {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(e.x, e.y, EYE.rx, EYE.ry, 0, 0, Math.PI * 2);
          ctx.clip();
          const h = EYE.ry * 2 * lid;
          ctx.fillStyle = skin;
          ctx.fillRect(e.x - EYE.rx, e.y - EYE.ry, EYE.rx * 2, h);
          ctx.strokeStyle = 'rgba(35,18,10,0.75)';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(e.x - EYE.rx, e.y - EYE.ry + h);
          ctx.quadraticCurveTo(e.x, e.y - EYE.ry + h + 3, e.x + EYE.rx, e.y - EYE.ry + h);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Mood light
      if (look.tint && f.tintA > 0.02) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = f.tintA;
        ctx.globalCompositeOperation = 'soft-light';
        ctx.fillStyle = look.tint.replace(/[\d.]+\)$/, '0.9)');
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
      if (st === 'error') {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(10,8,20,0.35)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    img.onload = () => { sampleSkin(); size(); };
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [levelRef]);

  return (
    <div className={`orin-stage ${state}`}>
      <canvas ref={canvasRef} className="orin-canvas" role="img" aria-label={`${GURU_NAME}, the Dream Guru — ${state}`} />
    </div>
  );
}
