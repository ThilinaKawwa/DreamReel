// Dream Director unit tests: DreamBible, storyboard, prompt compiler, quality checks.
// The model answers below are hand-written fixtures shaped like real output for the
// four test dreams; they test OUR validation and compilation, not the model itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBible, DIRECTOR_VERSION } from '../lib/director/bible.js';
import { normalizeStoryboard, soundsWritten, plainNarration } from '../lib/director/storyboard.js';
import { referencePrompts, keyframeRequest, videoRequest, characterLock } from '../lib/director/compiler.js';
import { judgeClipLog } from '../lib/cinema/quality.js';
import { expressionFor, EXPRESSIONS } from '../lib/guru-expression.js';
import { planTimeline } from '../lib/reel/timeline.js';
import { EVENTS } from '../lib/events.js';

const DREAM1 = "I was in my childhood house but it was also kind of like a train station. My brother was there wearing a red jacket. He kept running up the stairs, and every time I followed him, the stairs became longer. At the end he turned around and he looked younger.";
const DREAM2 = 'I found a silver key in my pocket. I walked into a dark forest and the trees were whispering. Then I found a black door standing alone in the middle of the trees. When I opened it, there was the sea behind it.';
const DREAM3 = 'I was standing near the ocean and suddenly the water started rising upward into the sky like a giant wall. I could see whales swimming above me. I was scared but also amazed.';
const DREAM4 = 'Uh, I was in like this airport, but it was also my school I think, and my mum was there but she looked different, like younger, and um I was late for something and I kept running.';

const bible1Raw = {
  cleanedDream: 'I was in my childhood house, but it was also a train station. My brother was there in a red jacket. He kept running up the stairs and every time I followed, the stairs got longer. At the end he turned around and looked younger.',
  mood: 'nostalgic', visualStyle: 'cinematic_realism',
  dreamer: { mode: 'pov' },
  characters: [{ id: 'Brother 01', role: "the dreamer's brother", face: 'oval face, warm brown skin, dark eyes', hair: 'short black hair', build: 'slim', clothing: 'a red zip-up jacket over a grey t-shirt, dark jeans', emotionalState: 'restless', appearanceChanges: 'looks younger at the end' }],
  locations: [{ id: 'house_station_01', name: 'childhood house that is also a train station', architecture: 'terraced house hallway opening onto station platforms', lighting: 'dim fluorescent', palette: 'faded beige and green' }],
  objects: [{ id: 'stairs_01', name: 'the stairs', description: 'narrow carpeted stairs that keep getting longer' }],
  chronology: [
    { event: 'In the house-station', locationId: 'house_station_01', characterIds: ['brother_01'] },
    { event: 'Brother runs up the stairs', locationId: 'house_station_01', characterIds: ['brother_01', 'ghost_99'], objectIds: ['stairs_01'] },
    { event: 'Brother turns, younger', locationId: 'nowhere', characterIds: ['brother_01'] },
  ],
  continuityRules: ['brother_01 wears the same red jacket in every shot'],
};

test('bible: original transcript is kept untouched and IDs are clean and checked', () => {
  const b = normalizeBible(bible1Raw, DREAM1);
  assert.equal(b.originalTranscript, DREAM1);
  assert.equal(b.version, DIRECTOR_VERSION);
  assert.equal(b.characters[0].id, 'brother_01');
  assert.deepEqual(b.chronology[1].characterIds, ['brother_01'], 'unknown character dropped');
  assert.equal(b.chronology[2].locationId, 'house_station_01', 'unknown location falls back to a real one');
  assert.equal(b.dreamer.mode, 'pov');
});

test('bible: rejects an answer with no places or events', () => {
  assert.throws(() => normalizeBible({ locations: [] }, DREAM2));
  assert.throws(() => normalizeBible({ locations: [{ name: 'forest' }], chronology: [] }, DREAM2));
});

test('bible: duplicate IDs are made unique', () => {
  const b = normalizeBible({
    locations: [{ id: 'forest' }, { id: 'forest' }], chronology: [{ event: 'walk' }],
  }, DREAM2);
  assert.notEqual(b.locations[0].id, b.locations[1].id);
});

function sb1(bible) {
  return normalizeStoryboard({
    title: 'The longer stairs',
    shots: [
      { locationId: 'house_station_01', characterIds: ['brother_01'], shotType: 'establishing wide', camera: 'slow push in', visual: 'Hallway that opens onto a platform, brother at the foot of the stairs', action: 'brother glances back', narration: 'I was at home, but it was sort of a train station too.' },
      { locationId: 'house_station_01', characterIds: ['brother_01'], objectIds: ['stairs_01'], shotType: 'pov', camera: 'handheld follow', visual: 'Looking up the stairs at brother running', action: 'brother runs up the stairs', narration: 'Beneath a celestial tapestry, my brother ascended majestically toward the heavens.' },
      { locationId: 'house_station_01', characterIds: ['brother_01', 'mum_01'], shotType: 'close-up', camera: 'static', visual: 'Brother at the top, turning around', action: 'brother turns around', narration: 'And then he turned round, and he looked younger.' },
      { locationId: 'house_station_01', shotType: 'wide', camera: 'static', visual: '', action: '' },
    ],
  }, bible, { maxShots: 5 });
}

test('storyboard: unknown characters dropped, empty shots removed, purple narration replaced', () => {
  const b = normalizeBible(bible1Raw, DREAM1);
  const s = sb1(b);
  assert.equal(s.shots.length, 3);
  assert.deepEqual(s.shots[2].characterIds, ['brother_01']);
  assert.equal(s.narrationReplaced, 1);
  assert.ok(!soundsWritten(s.shots[1].narration), s.shots[1].narration);
  assert.equal(s.shots[0].narration, 'I was at home, but it was sort of a train station too.');
  assert.ok(s.shots.every((x) => x.duration === 5));
});

test('storyboard: max shots is respected (free plan = 3)', () => {
  const b = normalizeBible(bible1Raw, DREAM1);
  const raw = { shots: Array.from({ length: 8 }, () => ({ locationId: 'house_station_01', visual: 'v', action: 'a' })) };
  assert.equal(normalizeStoryboard(raw, b, { maxShots: 3 }).shots.length, 3);
});

test('narration guard: plain remembered lines pass, trailer lines fail', () => {
  assert.equal(soundsWritten('I was standing by the ocean, and then the water just started rising.'), false);
  assert.equal(soundsWritten('The ethereal ocean ascended toward the heavens.'), true);
  assert.equal(plainNarration('One. Two. Three.', 3).length, 3);
});

test('consistency: the brother is described with the SAME locked text and reference in every shot', () => {
  const b = normalizeBible(bible1Raw, DREAM1);
  const s = sb1(b);
  const lock = characterLock(b.characters[0]);
  assert.match(lock, /red zip-up jacket/);
  const refs = referencePrompts(b);
  assert.ok(refs.find((r) => r.key === 'character:brother_01'));
  for (const shot of s.shots) {
    const kf = keyframeRequest(b, shot);
    assert.equal(kf.refs[0], 'character:brother_01', 'brother reference image is always attached first');
    assert.match(kf.prompt, /Image 1 shows the dreamer's brother — keep exactly the same face/);
    assert.match(kf.prompt, /red zip-up jacket/);
    const v = videoRequest(b, shot);
    assert.match(v.prompt, /red zip-up jacket/);
    assert.deepEqual(v.elements, ['character:brother_01']);
  }
  const pov = keyframeRequest(b, s.shots[1]);
  assert.match(pov.prompt, /first-person POV/);
});

test('dream 2: the silver key keeps its reference through forest → door → sea', () => {
  const b = normalizeBible({
    cleanedDream: 'I found a silver key in my pocket. I walked into a dark forest. There was a black door alone in the trees. Behind it was the sea.',
    locations: [{ id: 'forest_01', name: 'dark forest' }, { id: 'sea_01', name: 'the sea behind the door' }],
    objects: [{ id: 'silver_key_01', name: 'silver key', description: 'old ornate silver key' }, { id: 'black_door_01', name: 'black door', description: 'a free-standing matte black wooden door' }],
    chronology: [{ event: 'key', objectIds: ['silver_key_01'] }, { event: 'door', objectIds: ['black_door_01'] }, { event: 'sea', locationId: 'sea_01' }],
  }, DREAM2);
  const s = normalizeStoryboard({ shots: [
    { locationId: 'forest_01', objectIds: ['silver_key_01'], shotType: 'insert', visual: 'hand holding the key', action: 'fingers turn the key' },
    { locationId: 'forest_01', objectIds: ['black_door_01', 'silver_key_01'], visual: 'door among trees', action: 'door swings open' },
    { locationId: 'sea_01', objectIds: ['black_door_01'], visual: 'sea through the doorway', action: 'waves roll in' },
  ] }, b, { maxShots: 5 });
  const k = keyframeRequest(b, s.shots[1]);
  assert.deepEqual(k.refs, ['location:forest_01', 'object:black_door_01', 'object:silver_key_01']);
  assert.match(k.prompt, /silver key — keep it identical/);
  assert.equal(keyframeRequest(b, s.shots[2]).refs[0], 'location:sea_01');
});

test('dream 3 and 4: surreal ocean and messy speech still produce valid bibles', () => {
  const b3 = normalizeBible({ mood: 'cosmic', visualStyle: 'surreal_realism', locations: [{ id: 'shore_01', name: 'ocean shore' }], chronology: [{ event: 'water rises into the sky' }, { event: 'whales swim above' }] }, DREAM3);
  assert.equal(b3.characters.length, 0);
  assert.equal(b3.dreamer.mode, 'pov');
  const b4 = normalizeBible({ locations: [{ id: 'airport_school_01', name: 'airport that is also school' }], characters: [{ id: 'mum_01', role: "the dreamer's mum", clothing: 'green cardigan', appearanceChanges: 'younger' }], chronology: [{ event: 'running late', characterIds: ['mum_01'] }] }, DREAM4);
  assert.equal(b4.originalTranscript, DREAM4, 'the ums and likes stay in the original');
  assert.equal(b4.characters[0].appearanceChanges, 'younger');
  assert.equal(b4.visualStyle, 'surreal_realism');
});

test('quality: clips that are black, frozen, short or broken are rejected', () => {
  const head = 'Duration: 00:00:05.04, start: 0\n  Stream #0:0[0x1](und): Video: h264 (High)';
  assert.deepEqual(judgeClipLog(0, head), { ok: true, seconds: 5.04 });
  assert.equal(judgeClipLog(1, head).ok, false);
  assert.equal(judgeClipLog(0, head.replace('05.04', '01.00')).ok, false);
  assert.equal(judgeClipLog(0, `${head}\n[blackdetect] black_start:0 black_end:4 black_duration:4`).reason, 'mostly black');
  // Real ffmpeg 7 output for a still clip: a start line and no end line.
  assert.equal(judgeClipLog(0, `${head}\n[freezedetect @ 0x7f] lavfi.freezedetect.freeze_start: 0`).reason, 'no movement');
  assert.equal(judgeClipLog(0, `${head}\n[freezedetect @ 0x7f] lavfi.freezedetect.freeze_start: 1\n[freezedetect @ 0x7f] lavfi.freezedetect.freeze_end: 2`).ok, true, 'a short pause is fine');
  assert.equal(judgeClipLog(0, 'Duration: 00:00:05.00').reason, 'no video stream');
});

test('timeline: a video clip is shown in full even when its line is short', () => {
  const t = planTimeline([1.2, null], { minSeconds: [5, 5] });
  assert.ok(t.scenes[0].duration >= 5);
  assert.ok(t.scenes[1].duration >= 5);
});

test('guru expressions are always one of the seven', () => {
  for (const s of ['I am so sorry, that sounds frightening.', 'Tell me, who was standing at the door?', 'In many traditions water is a symbol of feeling.', 'Hello.']) {
    assert.ok(EXPRESSIONS.includes(expressionFor(s)));
  }
  assert.equal(expressionFor('I am sorry — that must have been frightening.'), 'concerned');
  assert.equal(expressionFor('Who was standing at the door?'), 'curious');
});

test('analytics: every new pipeline and guru event is allowed', () => {
  for (const e of ['dream_parse_completed', 'character_reference_generated', 'storyboard_completed', 'video_clip_started', 'video_clip_completed', 'video_clip_failed', 'reel_completed', 'reel_watched', 'reel_download_blocked_free', 'upgrade_clicked', 'guru_opened', 'guru_voice_started', 'guru_response_completed', 'guru_chat_mode_opened']) {
    assert.ok(EVENTS.includes(e), e);
  }
});
