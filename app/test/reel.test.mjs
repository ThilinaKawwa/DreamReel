// Unit tests for the Dream Reel film pipeline. Run: npm test
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { planTimeline, CROSSFADE, END_CARD, SILENT_SCENE } from '../lib/reel/timeline.js';
import { buildAss, assText } from '../lib/reel/captions.js';
import { validateNarration, fallbackMood } from '../lib/reel/narration.js';
import { wavSeconds } from '../lib/reel/render.js';
import { EVENTS, safeProps } from '../lib/events.js';
import { reelFilename } from '../lib/brand.js';

test('timeline: every line is spoken before the next scene speaks', () => {
  const t = planTimeline([4.6, 5.3, 4.2, 4.3, 4.6]);
  for (let i = 0; i < t.scenes.length - 1; i++) {
    const endOfLine = t.scenes[i].voiceAt + [4.6, 5.3, 4.2, 4.3, 4.6][i];
    assert.ok(endOfLine < t.scenes[i + 1].voiceAt - 0.5, `line ${i} overlaps the next`);
    // scenes cross-fade into each other exactly
    assert.equal(Math.round((t.scenes[i].start + t.scenes[i].duration - CROSSFADE) * 1000), Math.round(t.scenes[i + 1].start * 1000));
  }
  assert.ok(t.total > 15 && t.total < 35, `total ${t.total}s is outside 15–35s`);
  assert.equal(Math.round((t.total - t.endCard.start) * 1000), Math.round(END_CARD * 1000));
});

test('timeline: silent reels still get a calm pace', () => {
  const t = planTimeline([null, null, null, null, null]);
  t.scenes.forEach((s) => { assert.equal(s.duration, SILENT_SCENE); assert.equal(s.voiceAt, null); });
  assert.ok(t.total >= 15 && t.total <= 30);
});

test('timeline: a long line is never cut off', () => {
  const t = planTimeline([12]);
  assert.ok(t.scenes[0].duration >= 12 + CROSSFADE);
});

test('captions: user text cannot inject subtitle commands', () => {
  assert.equal(assText('Hello {\\pos(1,1)} world\n\\N again'), 'Hello pos(1,1) world N again');
  const ass = buildAss({
    timeline: planTimeline([3, 3]),
    lines: ['A sea {\\b1}of stars', ''],
    brand: { footer: 'Dream Reel', title: 'Dream Reel', tagline: ['Dreams disappear.', 'Keep yours.'], domain: 'dreamreel.app' },
  });
  assert.match(ass, /Caption,,0,0,0,,\{\\fad\(450,350\)\\blur9\}A sea b1of stars/);
  assert.equal((ass.match(/,Caption,/g) || []).length, 1, 'empty lines produce no caption');
  assert.match(ass, /DREAM REEL/);
  assert.match(ass, /Keep yours\./);
  assert.match(ass, /dreamreel\.app/);
});

test('narration: accepts a faithful answer, rejects broken ones', () => {
  const lines = ['I walked along a silent ocean at night.', 'The water rose slowly into the sky.', 'I could not tell which way was down.'];
  assert.deepEqual(validateNarration({ lines, mood: 'cosmic' }, 3), { lines, mood: 'cosmic' });
  assert.equal(validateNarration({ lines: lines.slice(0, 2), mood: 'cosmic' }, 3), null, 'wrong count');
  assert.equal(validateNarration({ lines: [...lines.slice(0, 2), 'word '.repeat(40)], mood: 'x' }, 3), null, 'too long');
  assert.equal(validateNarration({ lines, mood: 'party' }, 3).mood, null, 'unknown mood dropped');
  assert.equal(fallbackMood('neon'), 'mysterious');
  assert.equal(fallbackMood('anything'), 'dreamy');
});

test('wav: reads length from the header, including streamed files', () => {
  const make = (seconds, dataSize) => {
    const rate = 24000, bytes = Math.round(seconds * rate) * 2;
    const b = Buffer.alloc(44 + bytes);
    b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(dataSize ?? bytes, 40);
    return b;
  };
  assert.equal(Math.round(wavSeconds(make(2.5)) * 100) / 100, 2.5);
  assert.equal(Math.round(wavSeconds(make(1.25, 0xffffffff)) * 100) / 100, 1.25);
  assert.equal(wavSeconds(Buffer.from('not a wav')), null);
});

test('analytics: only behaviour is recorded, never dream text', () => {
  const p = safeProps({ seconds: 27.123456, method: 'file', ok: true, transcript: 'I dreamt of my ex', 'Bad Key': 1, nested: { a: 1 } });
  assert.deepEqual(p, { seconds: 27.123, method: 'file', ok: true });
  assert.ok(EVENTS.includes('video_shared'));
  // The app's list and the database's allowed list (latest migration) must match exactly.
  const sql = readFileSync(new URL('../supabase/migrations/20261022_guru_memory.sql', import.meta.url), 'utf8');
  const allowed = sql.slice(sql.lastIndexOf('check (event in (')).match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...allowed].sort(), [...EVENTS].sort());
});

test('filenames are tidy and safe', () => {
  assert.equal(reelFilename('Ocean in the Sky!'), 'dream-reel-ocean-in-the-sky.mp4');
  assert.equal(reelFilename('../../etc/passwd'), 'dream-reel-etc-passwd.mp4');
  assert.equal(reelFilename(''), 'dream-reel-my-dream.mp4');
  assert.equal(reelFilename('Café Ñoño'), 'dream-reel-cafe-nono.mp4');
});
