'use client';

import { useCallback, useEffect, useState } from 'react';
import Player from '@/components/Player';
import ReelHero, { STAGE_WORDS } from '@/components/ReelHero';
import DreamMemory from '@/components/DreamMemory';
import { getBrowserSupabase } from '@/lib/supabase';
import { api } from '@/lib/api';
import { dreamDate } from '@/lib/profile';
import { track } from '@/lib/analytics';
import { BRAND, siteUrl } from '@/lib/brand';

/**
 * A single dream. Its owner sees their film (made automatically) with Download and
 * Share. Anyone else holding a shared link sees the reel and an invitation to make theirs.
 */
export default function DreamView({ dream: shared, id }) {
  const [dream, setDream] = useState(shared);
  const [checked, setChecked] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [access, setAccess] = useState(null); // from /api/me/entitlements (display only)
  const [reading, setReading] = useState(null);
  const [making, setMaking] = useState(null);
  const [toast, setToast] = useState('');

  const say = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(''), 2600); }, []);

  // Is this my dream? Owners load the full record (private dreams never reach the server page).
  useEffect(() => {
    const supabase = getBrowserSupabase();
    let cancelled = false;
    supabase.auth.getSession().then(async ({ data }) => {
      const uid = data.session?.user?.id;
      if (uid) {
        const { data: own } = await supabase.from('dreams').select('*').eq('id', id).eq('user_id', uid).maybeSingle();
        if (own && !cancelled) {
          setDream(own);
          loadPictures(own);
          setIsOwner(true);
          const isNew = new URLSearchParams(window.location.search).has('new');
          if (!isNew) track('dream_reopened', { status: own.status }, { onceKey: `reopen-${id}` });
          loadAccess(supabase);
        }
      }
      if (!cancelled) setChecked(true);
    });
    return () => { cancelled = true; };

    // Private Dream Director pictures: short-lived links from the server (owner only).
    async function loadPictures(own) {
      if (!own.scenes?.some((sc) => sc.image_path)) return;
      const m = await api(`/api/dreams/${id}/media`, { method: 'GET' }).catch(() => null);
      if (m?.scenes && !cancelled) setDream((d) => ({ ...d, scenes: m.scenes }));
    }

    async function loadAccess(supabase) {
      const upgraded = new URLSearchParams(window.location.search).has('upgraded');
      if (upgraded) say('Welcome to Premium ✦');
      // After checkout the webhook can take a few seconds to land.
      for (let i = 0; i < (upgraded ? 8 : 1); i++) {
        const a = await api('/api/me/entitlements', { method: 'GET' }).catch(() => null);
        if (a && (a.plan === 'premium' || i === (upgraded ? 7 : 0))) { if (!cancelled) setAccess(a); break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
      const { data: r } = await supabase.from('dream_readings').select('*').eq('dream_id', id).maybeSingle();
      if (r && !cancelled) setReading(r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // While the Dream Director works on a new dream, show its real stage and reload when frames exist.
  const pending = isOwner && dream && dream.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      const r = await api(`/api/dreams/${id}/reel`, { method: 'GET' }).catch(() => null);
      if (stop || !r) return;
      setMaking(r);
      if (r.dreamReady || r.status === 'completed') {
        const { data: fresh } = await getBrowserSupabase().from('dreams').select('*').eq('id', id).maybeSingle();
        if (fresh && !stop) {
          const m = fresh.scenes?.some((sc) => sc.image_path) ? await api(`/api/dreams/${id}/media`, { method: 'GET' }).catch(() => null) : null;
          setDream(m?.scenes ? { ...fresh, scenes: m.scenes } : fresh);
        }
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [pending, id]);

  async function retryCinematic() {
    setMaking((m) => ({ ...m, status: 'processing', stage: null }));
    const r = await api(`/api/dreams/${id}/reel`, { json: { retry: true } }).catch((e) => ({ status: 'failed', error: e.message, canRetry: false, mode: 'cinematic' }));
    setMaking(r);
  }

  // Secondary sharing: a link. Making a link work is an explicit choice, because dreams are private.
  async function copyLink() {
    if (!dream.is_public) {
      const ok = window.confirm('Make a link anyone can open? They will see this reel and its captions — never your recording or what you said word for word.');
      if (!ok) return;
      const { error } = await getBrowserSupabase().from('dreams').update({ is_public: true }).eq('id', id);
      if (error) { say("Couldn't make a link just now."); return; }
      setDream((d) => ({ ...d, is_public: true }));
    }
    const url = `${siteUrl() || window.location.origin}/d/${id}`;
    try { await navigator.clipboard.writeText(url); say('Link copied'); } catch { window.prompt('Copy this link', url); }
    track('video_shared', { method: 'link' });
  }

  async function makePrivate() {
    const { error } = await getBrowserSupabase().from('dreams').update({ is_public: false }).eq('id', id);
    if (!error) { setDream((d) => ({ ...d, is_public: false })); say('Link turned off'); }
  }

  if (!dream) {
    return (
      <main className="app">
        <div className="create-top"><a href="/" className="iconbtn" aria-label="Back">←</a></div>
        <div className="empty">
          {checked ? (
            <><h2>This dream isn't here</h2><p className="lead">It may be private, or the link is wrong.</p><a className="btn primary" href="/">Capture your own dream</a></>
          ) : (
            <p className="lead">Opening…</p>
          )}
        </div>
      </main>
    );
  }

  const date = new Date(dream.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });

  if (dream.status !== 'ready' && isOwner && dream.status === 'pending' && making?.mode === 'cinematic') {
    const failed = making.status === 'failed';
    return (
      <main className="app">
        <div className="create-top"><a href="/" className="iconbtn" aria-label="Back">←</a><span className="eyebrow">{dreamDate(dream.created_at)}</span></div>
        <div className="empty" role="status" aria-live="polite">
          {!failed && <span className="orb" aria-hidden="true" />}
          <h2>{failed ? "This one didn't finish" : STAGE_WORDS[making.stage] || 'Understanding your dream…'}</h2>
          <p className="lead">{failed ? making.error : 'Real video takes a few minutes. You can leave this page — it keeps going.'}</p>
          {failed && making.canRetry && <button className="btn primary" onClick={retryCinematic}>Try again</button>}
          {failed && !making.canRetry && <a className="btn primary" href="/">Tell Orin again</a>}
        </div>
      </main>
    );
  }

  // 'saved' = a dream told to Orin: kept as a memory, with no pictures unless they choose to visualize it.
  if (dream.status !== 'ready' && !(isOwner && dream.status === 'saved')) {
    return (
      <main className="app">
        <div className="create-top"><a href="/" className="iconbtn" aria-label="Back">←</a><span className="eyebrow">{dreamDate(dream.created_at)}</span></div>
        <div className="empty">
          <h2>{dream.status === 'failed' ? "This one didn't paint" : checked && !isOwner && dream.status === 'saved' ? "This dream isn't here" : 'Still painting…'}</h2>
          <p className="lead">{dream.status === 'failed' ? 'Try telling it again.' : 'Give it a moment and refresh.'}</p>
          <a className="btn primary" href="/">Talk to Orin</a>
        </div>
      </main>
    );
  }

  const summary = isOwner && access?.canUseGuruReading ? reading?.summary || null : null;
  const hasScenes = (dream.scenes || []).length > 0;

  return (
    <main className="app" style={{ gap: 14 }}>
      <div className="create-top">
        <a href={isOwner ? '/dreams' : '/'} className="iconbtn" aria-label="Back">←</a>
        <span className="eyebrow accent">{dreamDate(dream.created_at)}</span>
        <span className="iconbtn" aria-hidden="true" style={{ visibility: 'hidden' }} />
      </div>

      {isOwner ? (
        hasScenes && <ReelHero dream={dream} date={date} summary={summary} onShareLink={copyLink} />
      ) : (
        <Player scenes={dream.scenes} date={date} />
      )}

      <div className="center">
        <h2>{dream.title || 'A remembered dream'}</h2>
        <div className="eyebrow" style={{ marginTop: 8 }}>{date}</div>
      </div>

      {isOwner && hasScenes && (
        <div className="reel-secondary">
          <button className="linkbtn" onClick={copyLink}>Copy link</button>
          {dream.is_public && (<><span aria-hidden="true">·</span><button className="linkbtn" onClick={makePrivate}>Turn off link</button></>)}
        </div>
      )}
      {!isOwner && (
        <section className="invite-card">
          <p className="lead">{BRAND.promise}</p>
          <a className="btn primary block" href="/">Capture your own dream</a>
        </section>
      )}

      {isOwner && <DreamMemory id={id} hasScenes={hasScenes} onTitle={(t) => setDream((d) => ({ ...d, title: t || d.title }))} />}
      <div className={`toast ${toast ? 'on' : ''}`} role="status">{toast}</div>
    </main>
  );
}
