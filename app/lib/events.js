// The only analytics events Dream Reel records. Behaviour only — never dream text.
// (The database enforces this same list.)
export const EVENTS = [
  'landing_view', 'signup_started', 'signup_completed',
  'recording_started', 'recording_completed', 'dream_submitted',
  'dream_generation_started', 'dream_generation_completed', 'dream_generation_failed',
  'reel_render_started', 'reel_render_completed', 'reel_render_failed',
  'video_played', 'video_completed', 'video_downloaded', 'video_shared',
  'gallery_opened', 'dream_reopened', 'return_session',
  // Dream Director pipeline (server)
  'dream_parse_completed', 'character_reference_generated', 'storyboard_completed',
  'video_clip_started', 'video_clip_completed', 'video_clip_failed', 'reel_completed',
  // Access + Guru
  'reel_watched', 'reel_download_blocked_free', 'upgrade_clicked',
  'guru_opened', 'guru_voice_started', 'guru_response_completed', 'guru_chat_mode_opened',
];

/** Keeps only short, non-text-like values: numbers, booleans and tiny labels. */
export function safeProps(props = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props || {}).slice(0, 12)) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[a-z0-9_.:-]{1,40}$/i.test(v)) out[k] = v;
  }
  return out;
}
