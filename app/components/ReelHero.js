'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Player from '@/components/Player';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { BRAND } from '@/lib/brand';

// Words for each real stage the server reports (see lib/reel/pipeline.js).
const STAGE_WORDS = {
  queued: 'Creating your Dream Reel…',
  writing: 'Writing your narration…',
  voice: 'Recording the narration…',
  animating: 'Adding movement…',
  finishing: 'Finishing your reel…',
  saving: 'Saving your film…',
};

/**
 * The finished film for the dream's owner: plays it, downloads it, shares it.
 * Starts making it automatically the first time the owner opens the dream.
 */
export default function ReelHero({ dream, date, summary }) {
  const [reel, setReel] = useState({ status: 'loading' });
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const fileRef = useRef(null);
  const startedRef = useRef(false);
  const playedRef = useRef(false);
  const videoRef = useRef(null);

  const say = (m) => { setNote(m); setTimeout(() => setNote(''), 3500); };

  const refresh = useCallback(async () => {
    try {
      const r = await api(`/api/dreams/${dream.id}/reel`, { method: 'GET' });
      setReel(r);
      return r;
    } catch (e) {
      setReel({ status: 'unavailable', error: e.message });
      return null;
    }
  }, [dream.id]);

  const start = useCallback(async () => {
    setReel((r) => ({ ...r, status: 'queued', stage: null, error: null }));
    try {
      const r = await api(`/api/dreams/${dream.id}/reel`, { json: {} });
      setReel(r);
    } catch (e) {
      setReel({ status: e.status === 503 ? 'unavailable' : 'failed', error: e.message, canRetry: e.status !== 429 });
    }
  }, [dream.id]);

  // First look: if there's no film yet, start making it.
  useEffect(() => {
    refresh().then((r) => {
      if (r?.status === 'not_started' && !startedRef.current) { startedRef.current = true; start(); }
    });
  }, [refresh, start]);

  // While it's being made, check every few seconds.
  const making = reel.status === 'queued' || reel.status === 'processing';
  useEffect(() => {
    if (!making) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [making, refresh]);

  // Signed links expire after two hours; refresh them quietly if the tab stays open.
  useEffect(() => {
    if (reel.status !== 'completed') return;
    const t = setInterval(refresh, 90 * 60 * 1000);
    return () => clearInterval(t);
  }, [reel.status, refresh]);

  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

  // Phones share the actual video file, which must be ready the moment they tap.
  async function prepareFile() {
    if (fileRef.current) return fileRef.current;
    const res = await fetch(reel.videoUrl);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    fileRef.current = new File([blob], reel.filename || 'dream-reel.mp4', { type: 'video/mp4' });
    return fileRef.current;
  }

  function download({ viaShare = false } = {}) {
    const a = document.createElement('a');
    a.href = reel.downloadUrl;
    a.download = reel.filename || 'dream-reel.mp4';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (!viaShare) track('video_downloaded');
    say('Downloading your Dream Reel');
  }

  async function share() {
    if (busy) return;
    if (canShareFiles) {
      let file = fileRef.current;
      if (!file) {
        setBusy('Preparing…');
        try { file = await prepareFile(); } catch { setBusy(''); say("Couldn't prepare the video. Try Download instead."); return; }
        setBusy('');
      }
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: dream.title || BRAND.name, text: BRAND.promise });
          track('video_shared', { method: 'file' });
        } catch (e) {
          // Some phones need a fresh tap after the file has loaded.
          if (e?.name === 'NotAllowedError') say('Ready — tap Share again');
        }
        return;
      }
    }
    // No file sharing on this browser: save it so it can be posted from the camera roll / downloads.
    download({ viaShare: true });
    track('video_shared', { method: 'download' });
  }

  // Prepare the share file in the background on phones once the film has loaded.
  function onLoaded() {
    if (canShareFiles && reel.videoUrl && !fileRef.current) prepareFile().catch(() => {});
  }

  const done = reel.status === 'completed' && reel.videoUrl;

  return (
    <section className="reel-hero" aria-label="Your Dream Reel">
      {done ? (
        <video
          ref={videoRef}
          className="reel-video"
          src={reel.videoUrl}
          poster={reel.posterUrl || dream.scenes?.[0]?.image_url}
          controls
          playsInline
          preload="metadata"
          onLoadedData={onLoaded}
          onPlay={() => { if (!playedRef.current) { playedRef.current = true; track('video_played', { seconds: Math.round(reel.duration || 0) }); } }}
          onEnded={() => track('video_completed')}
        />
      ) : (
        <div className="reel-making">
          <Player scenes={dream.scenes} date={date} summary={summary} />
          {(making || reel.status === 'not_started') && (
            <div className="reel-status" role="status" aria-live="polite">
              <span className="orb small" aria-hidden="true" />
              <div>
                <b>{STAGE_WORDS[reel.stage] || STAGE_WORDS.queued}</b>
                <small>Your film usually takes about a minute. You can leave this page — it will keep going.</small>
              </div>
            </div>
          )}
          {reel.status === 'failed' && (
            <div className="reel-status failed" role="alert">
              <div>
                <b>{reel.error || "Your reel didn't finish."}</b>
                {reel.canRetry !== false && <button className="btn" onClick={start}>Try again</button>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="reel-actions">
        <button className="btn primary" onClick={() => download()} disabled={!done}>↓ Download</button>
        <button className="btn" onClick={share} disabled={!done || Boolean(busy)}>{busy || '⤴ Share'}</button>
      </div>
      {!done && reel.status !== 'failed' && reel.status !== 'unavailable' && (
        <p className="fine">Download and Share appear when your film is ready.</p>
      )}
      {reel.status === 'unavailable' && <p className="fine">Films aren't available just yet — your dream is saved.</p>}
      <div className={`toast ${note ? 'on' : ''}`} role="status">{note}</div>
    </section>
  );
}
