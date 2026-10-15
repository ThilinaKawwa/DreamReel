"""Composes Dream Reel's ambient music library from scratch.

Every track is synthesised here (oscillators, filters, reverb), so the music is
original to Dream Reel and safe to use in shared videos — no licensing questions.

    python3 scripts/compose-music.py assets/music

Writes <mood>.wav (then encode to .m4a with ffmpeg; see README). Needs numpy.
"""
import math
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
LENGTH = 48.0  # seconds; reels are 15–35 s, the renderer fades out wherever it ends
rng = np.random.default_rng(20261015)

NOTE = {n: i for i, n in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])}


def hz(name):
    """'A3' → 220.0"""
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTE[pitch] + 12 * (octave + 1) - 69) / 12)


t = np.arange(int(SR * LENGTH)) / SR


def onepole_lp(x, cutoff):
    """Simple low-pass; cutoff may be an array (moving filter)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    a = np.exp(-2 * math.pi * cutoff / SR)
    y = np.empty_like(x)
    prev = 0.0
    for i in range(len(x)):  # 2M samples → fine for an offline script
        prev = (1 - a[i]) * x[i] + a[i] * prev
        y[i] = prev
    return y


def lowpass(x, cutoff, poles=2):
    for _ in range(poles):
        x = onepole_lp(x, cutoff)
    return x


def saw(freq, detune_cents=0.0, harmonics=18, wobble=None):
    f = freq * 2 ** (detune_cents / 1200)
    phase = 2 * math.pi * np.cumsum(np.full_like(t, f) * (1 + (wobble if wobble is not None else 0))) / SR
    phase += rng.uniform(0, 2 * math.pi)
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if f * k > SR / 2.5:
            break
        out += np.sin(k * phase) / k
    return out


def sine(freq, wobble=None):
    phase = 2 * math.pi * np.cumsum(np.full_like(t, freq) * (1 + (wobble if wobble is not None else 0))) / SR
    return np.sin(phase + rng.uniform(0, 2 * math.pi))


def chord_envelopes(n_chords, hold, fade):
    """Overlapping raised-cosine windows: one per chord, looping through the track."""
    step = hold
    envs = []
    for c in range(n_chords):
        env = np.zeros_like(t)
        start = c * step
        while start < LENGTH + step:
            s0, s1 = start - fade, start + step + fade
            m = (t >= s0) & (t < s1)
            x = (t[m] - s0) / (s1 - s0)
            env[m] += np.sin(math.pi * x) ** 1.3
            start += step * n_chords
        envs.append(env)
    return envs


def pad(chords, hold=8.0, fade=3.0, cutoff=(700, 1500), voices=3, spread=9, level=0.16, wobble=None, harmonics=16):
    envs = chord_envelopes(len(chords), hold, fade)
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    for chord, env in zip(chords, envs):
        for n in chord:
            f = hz(n)
            for v in range(voices):
                d = (v - (voices - 1) / 2) * spread
                s = saw(f, d, harmonics=harmonics, wobble=wobble) * env
                pan = 0.5 + 0.35 * math.sin(v * 2.1 + f)
                left += s * (1 - pan)
                right += s * pan
    lfo = (np.sin(2 * math.pi * t / 17.0) + 1) / 2
    cut = cutoff[0] + (cutoff[1] - cutoff[0]) * lfo
    return np.stack([lowpass(left, cut), lowpass(right, cut)]) * level / max(1, len(chords[0]))


def drone(note, level=0.12, wobble=None):
    s = sine(hz(note), wobble) + 0.35 * sine(hz(note) * 2.001, wobble)
    swell = 0.75 + 0.25 * np.sin(2 * math.pi * t / 23.0)
    s = s * swell * level
    return np.stack([s, s])


def bells(notes, every=(3.5, 7.0), level=0.07, decay=3.2, start=4.0):
    out = np.zeros((2, len(t)))
    when = start
    while when < LENGTH - 2:
        f = hz(notes[rng.integers(len(notes))])
        i0 = int(when * SR)
        tt = t[: len(t) - i0]
        env = np.exp(-tt / decay) * (1 - np.exp(-tt * 60))
        tone = (np.sin(2 * math.pi * f * tt) + 0.35 * np.sin(2 * math.pi * f * 2.76 * tt) * np.exp(-tt * 1.4)
                + 0.18 * np.sin(2 * math.pi * f * 5.4 * tt) * np.exp(-tt * 3))
        pan = rng.uniform(0.25, 0.75)
        out[0, i0:] += tone * env * level * (1 - pan) * 2
        out[1, i0:] += tone * env * level * pan * 2
        when += rng.uniform(*every)
    return out


def shimmer(notes, level=0.04):
    out = np.zeros((2, len(t)))
    for n in notes:
        f = hz(n)
        amp = (np.sin(2 * math.pi * t / rng.uniform(5, 11) + rng.uniform(0, 6)) + 1) / 2
        s = sine(f) * amp ** 2 * level
        pan = rng.uniform(0.2, 0.8)
        out[0] += s * (1 - pan)
        out[1] += s * pan
    return out


def wash(level=0.05, cutoff=(400, 1800), period=13.0):
    n = rng.normal(0, 1, (2, len(t)))
    lfo = (np.sin(2 * math.pi * t / period) + 1) / 2
    cut = cutoff[0] + (cutoff[1] - cutoff[0]) * lfo
    return np.stack([lowpass(n[0], cut, 2), lowpass(n[1], cut, 2)]) * level * (0.4 + 0.6 * lfo)


def reverb(x, seconds=3.5, mix=0.45):
    """Convolution with a decaying-noise impulse — a soft, wide hall."""
    n = int(SR * seconds)
    tt = np.arange(n) / SR
    out = []
    for ch in range(2):
        ir = rng.normal(0, 1, n) * np.exp(-tt * 6.9 / seconds)
        ir = lowpass(ir, 5000, 1)
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << int(math.ceil(math.log2(len(x[ch]) + n)))
        wet = np.fft.irfft(np.fft.rfft(x[ch], size) * np.fft.rfft(ir, size), size)[: len(x[ch])]
        out.append(x[ch] * (1 - mix) + wet * mix)
    return np.stack(out)


def finish(x, target_rms=0.09):
    x = x - x.mean(axis=1, keepdims=True)
    fade_in = np.clip(t / 3.0, 0, 1) ** 2
    fade_out = np.clip((LENGTH - t) / 4.0, 0, 1) ** 2
    x = x * fade_in * fade_out
    rms = np.sqrt(np.mean(x ** 2))
    x = x * (target_rms / max(rms, 1e-9))
    return np.tanh(x * 1.2) / 1.2  # gentle soft-clip, never harsh


def tape_wobble(depth=0.0025):
    return depth * np.sin(2 * math.pi * t / 4.7) + depth * 0.5 * np.sin(2 * math.pi * t / 1.3)


TRACKS = {
    # warm, floating, open — the default
    'dreamy': lambda: reverb(
        pad([['D3', 'A3', 'E4', 'F#4'], ['B2', 'F#3', 'C#4', 'D4'], ['G2', 'D3', 'B3', 'F#4'], ['A2', 'E3', 'B3', 'C#4']],
            hold=8, cutoff=(650, 1700))
        + drone('D2', 0.07) + shimmer(['A5', 'E6', 'F#6'], 0.03) + bells(['A4', 'D5', 'E5', 'F#5'], level=0.035),
        4.0, 0.5),
    # dark, hushed, questioning
    'mysterious': lambda: reverb(
        pad([['A2', 'E3', 'B3', 'C4'], ['F2', 'C3', 'E3', 'B3'], ['D2', 'A2', 'F3', 'E4'], ['E2', 'B2', 'D3', 'A3']],
            hold=9, cutoff=(380, 950), level=0.17)
        + drone('A1', 0.09) + wash(0.035, (250, 900), 17) + bells(['E5', 'C5', 'B4'], every=(6, 10), level=0.025, decay=4.5),
        4.5, 0.55),
    # bright, gentle, still — morning light
    'peaceful': lambda: reverb(
        pad([['C3', 'G3', 'B3', 'E4'], ['F2', 'C3', 'A3', 'G4'], ['A2', 'E3', 'G3', 'C4'], ['G2', 'D3', 'E3', 'B3']],
            hold=8, cutoff=(800, 1900), level=0.14)
        + bells(['C5', 'E5', 'G5', 'A5', 'D5'], every=(2.8, 5.2), level=0.05, decay=3.6),
        3.5, 0.45),
    # vast, airy, starfield
    'cosmic': lambda: reverb(
        pad([['E2', 'B2', 'F#3', 'G#3', 'D#4'], ['C#2', 'G#2', 'E3', 'B3', 'D#4']], hold=11, fade=4.5,
            cutoff=(500, 2200), level=0.15)
        + drone('E1', 0.08) + shimmer(['B5', 'D#6', 'F#6', 'G#6', 'B6'], 0.035) + wash(0.03, (900, 4000), 11),
        5.0, 0.6),
    # uneasy but never horror: slow clusters, drifting pitch
    'unsettling': lambda: reverb(
        pad([['C3', 'C#3', 'G3', 'F#4'], ['A#2', 'B2', 'F3', 'E4']], hold=10, fade=4.0, cutoff=(300, 800), level=0.16,
            wobble=0.004 * np.sin(2 * math.pi * t / 7.3))
        + drone('C2', 0.1, wobble=0.003 * np.sin(2 * math.pi * t / 9.1)) + wash(0.04, (150, 600), 19),
        4.5, 0.55),
    # warm, faded, a little bittersweet — like an old photograph
    'nostalgic': lambda: reverb(
        pad([['F2', 'C3', 'A3', 'E4'], ['E2', 'B2', 'G3', 'D4'], ['D2', 'A2', 'F3', 'C4'], ['C2', 'G2', 'E3', 'B3']],
            hold=8, cutoff=(500, 1200), level=0.15, wobble=tape_wobble())
        + bells(['A4', 'C5', 'E5', 'G4'], every=(4, 7), level=0.035, decay=4.0),
        3.8, 0.5),
}


def write_wav(path, x):
    pcm = (np.clip(x.T, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'assets/music')
    out.mkdir(parents=True, exist_ok=True)
    only = sys.argv[2:] or list(TRACKS)
    for name in only:
        audio = finish(TRACKS[name]())
        write_wav(out / f'{name}.wav', audio)
        print('composed', name)
