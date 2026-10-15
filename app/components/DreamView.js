'use client';

import { useCallback, useEffect, useState } from 'react';
import Player from '@/components/Player';
import ReelHero from '@/components/ReelHero';
import GuruPanel from '@/components/GuruPanel';
import { getBrowserSupabase } from '@/lib/supabase';
import { api, startPremium } from '@/lib/api';
import { dreamDate } from '@/lib/profile';
import { track } from '@/lib/analytics';
import { PREMIUM_ENABLED } from '@/lib/features';
import { BRAND, siteUrl } from '@/lib/brand';

const ACTIVE = ['active', 'trialing'];

/**
 * A single dream. Its owner sees their film (made automatically) with Download and
 * Share. Anyone else holding a shared link sees the reel and an invitation to make theirs.
 */
export default function DreamView({ dream: shared, id }) {
  const [dream, setDream] = useState(shared);
  const [checked, setChecked] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [premium, setPremium] = useState(PREMIUM_ENABLED ? null : false);
  const [reading, setReading] = useState(null);
  const [details, setDetails] = useState(false);
  const [toast, setToast] = useState('');
  const [animError, setAnimError] = useState('');

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
          setIsOwner(true);
          const isNew = new URLSearchParams(window.location.search).has('new');
          if (!isNew) track('dream_reopened', { status: own.status }, { onceKey: `reopen-${id}` });
          if (PREMIUM_ENABLED) await loadPremium(supabase, uid, cancelled);
        }
      }
      if (!cancelled) { setChecked(true); if (!PREMIUM_ENABLED) setPremium(false); }
    });
    return () => { cancelled = true; };

    async function loadPremium(supabase, uid) {
      const upgraded = new URLSearchParams(window.location.search).has('upgraded');
      if (upgraded) say('Welcome to Premium ✦');
      for (let i = 0; i < (upgraded ? 8 : 1); i++) {
        const { data: profile } = await supabase.from('profiles').select('plan, subscription_status').eq('user_id', uid).maybeSingle();
        const ok = profile?.plan === 'premium' && ACTIVE.includes(profile?.subscription_status);
        if (ok || i === (upgraded ? 7 : 0)) { setPremium(ok); break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
      const { data: r } = await supabase.from('dream_readings').select('*').eq('dream_id', id).maybeSingle();
      if (r) setReading(r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onReading = useCallback((r) => setReading(r), []);

  async function animate() {
    setAnimError('');
    try {
      const d = await api(`/api/dreams/${id}/video`);
      setDream((x) => ({ ...x, scenes: d.scenes, video_status: d.video_status }));
    } catch (e) {
      if (e.upgrade) startPremium().catch(() => setAnimError(e.message));
      else setAnimError(e.message);
    }
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
            <><h2>This dream isn't here</h2><p className="lead">It may be private, or the link is wrong.</p><a className="btn primary" href="/create">Capture your own dream</a></>
          ) : (
            <p className="lead">Opening…</p>
          )}
        </div>
      </main>
    );
  }

  const date = new Date(dream.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });

  if (dream.status !== 'ready') {
    return (
      <main className="app">
        <div className="create-top"><a href="/" className="iconbtn" aria-label="Back">←</a><span className="eyebrow">{dreamDate(dream.created_at)}</span></div>
        <div className="empty">
          <h2>{dream.status === 'failed' ? "This one didn't paint" : 'Still painting…'}</h2>
          <p className="lead">{dream.status === 'failed' ? 'Try telling it again.' : 'Give it a moment and refresh.'}</p>
          <a className="btn primary" href="/create">New dream</a>
        </div>
      </main>
    );
  }

  const summary = isOwner && premium ? reading?.summary || null : null;

  return (
    <main className="app" style={{ gap: 14 }}>
      <div className="create-top">
        <a href={isOwner ? '/gallery' : '/'} className="iconbtn" aria-label="Back">←</a>
        <span className="eyebrow accent">{dreamDate(dream.created_at)}</span>
        <span className="iconbtn" aria-hidden="true" style={{ visibility: 'hidden' }} />
      </div>

      {isOwner ? (
        <ReelHero dream={dream} date={date} summary={summary} />
      ) : (
        <Player scenes={dream.scenes} date={date} />
      )}

      <div className="center">
        <h2>{dream.title || 'Untitled dream'}</h2>
        <div className="eyebrow" style={{ marginTop: 8 }}>{date}</div>
      </div>

      {isOwner ? (
        <div className="reel-secondary">
          <button className="linkbtn" onClick={() => setDetails((v) => !v)} aria-expanded={details}>{details ? 'Hide dream' : 'View dream'}</button>
          <span aria-hidden="true">·</span>
          <button className="linkbtn" onClick={copyLink}>Copy link</button>
          {dream.is_public && (<><span aria-hidden="true">·</span><button className="linkbtn" onClick={makePrivate}>Turn off link</button></>)}
          <span aria-hidden="true">·</span>
          <a className="linkbtn" href="/create">New dream</a>
        </div>
      ) : (
        <section className="invite-card">
          <p className="lead">{BRAND.promise}</p>
          <a className="btn primary block" href="/create">Capture your own dream</a>
        </section>
      )}

      {isOwner && details && (
        <section className="dream-details" aria-label="Your dream">
          {dream.transcript && <p className="transcript">“{dream.transcript}”</p>}
          <ol className="scene-list">
            {(dream.scenes || []).map((s, i) => <li key={i}>{s.caption}</li>)}
          </ol>
        </section>
      )}

      {PREMIUM_ENABLED && isOwner && premium && !dream.video_status && (
        <button className="btn block" onClick={animate}>✦ Bring this dream to life (moving video)</button>
      )}
      {PREMIUM_ENABLED && isOwner && dream.video_status === 'animating' && (
        <p className="fine">Moving clips are being made — make the film again once they're ready.</p>
      )}
      {animError && <div className="error">{animError}</div>}
      {PREMIUM_ENABLED && isOwner && <GuruPanel dream={dream} premium={premium} reading={reading} onReading={onReading} />}
      <div className={`toast ${toast ? 'on' : ''}`} role="status">{toast}</div>
    </main>
  );
}
