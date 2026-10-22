// Every AI model and voice the app uses, in one place, all overridable by environment
// variable. Pure (no imports) so it can be tested. Video model IDs live in lib/providers.
export function models(env = process.env) {
  return {
    director: env.DIRECTOR_MODEL || 'gpt-4.1',            // DreamBible + storyboard
    guru: env.GURU_MODEL || 'gpt-4.1',                    // Guru readings and chat
    memory: env.MEMORY_MODEL || 'gpt-4.1-mini',          // dream memory extraction (structured, cheap)
    narrationLegacy: env.NARRATION_MODEL || 'gpt-4o-mini', // old picture renderer only
    // Speech → text. gpt-transcribe replaces the deprecated gpt-4o-mini-transcribe.
    transcription: env.TRANSCRIPTION_MODEL || 'gpt-transcribe',
    transcriptionFallback: env.TRANSCRIPTION_FALLBACK_MODEL || '', // off by default (same endpoint, low risk)
    // Text → speech. gpt-realtime-2.1-mini is OpenAI's named replacement for the deprecated
    // gpt-4o-mini-tts. lib/audio/speech.js calls the standard /v1/audio/speech endpoint first and
    // only uses its small Realtime adapter if OpenAI rejects the model there. The fallback model
    // is a TEMPORARY emergency path (OpenAI removes it 2027-01-06); every use is recorded.
    // Set TTS_FALLBACK_MODEL= (empty) to turn it off.
    tts: env.TTS_MODEL || 'gpt-realtime-2.1-mini',
    ttsFallback: env.TTS_FALLBACK_MODEL ?? 'gpt-4o-mini-tts',
    narratorVoice: env.NARRATOR_VOICE || 'marin',
    guruVoice: env.GURU_VOICE || 'cedar',
    // Video routing (see lib/director/routing.js). VIDEO_PROVIDER / PREMIUM_VIDEO_PROVIDER
    // are accepted as older names for the scenic / identity providers.
    scenicVideo: env.SCENIC_VIDEO_PROVIDER || env.VIDEO_PROVIDER || 'kling-i2v',
    identityVideo: env.IDENTITY_VIDEO_PROVIDER || env.PREMIUM_VIDEO_PROVIDER || 'kling-o1-ref',
  };
}

/** True for models that speak only through the Realtime API (not /v1/audio/speech). */
export function isRealtimeModel(model) {
  return /^gpt-realtime/.test(String(model || ''));
}
