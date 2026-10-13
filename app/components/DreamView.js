'use client';

import { useCallback, useEffect, useState } from 'react';
import Player from '@/components/Player';
import GuruPanel from '@/components/GuruPanel';
import { getBrowserSupabase } from '@/lib/supabase';
import { api, startPremium } from '@/lib/api';
import { dreamDate } from '@/lib/profile';

const ACTIVE = ['active', 'trialing'];

export default function DreamView({ dream: initial, id }) {
  const [dream, setDream] = useState(initial);
  const [toast, setToast] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [premium, setPremium] = useState(null); // null = still checking
  const [reading, setReading] = useState(null);
  const [animError, setAnimError] = useState('');

  const say = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); }, []);

  // Who is watching? The owner gets the Guru; everyone else just the reel.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    let cancelled = false;
    supabase.auth.getSession().then(async ({ data }) => {
      const uid = data.session?.user?.id;
      let d = dream;
      if (!d && uid) {
        const { data: own } = await supabase.from('dreams').select('*').eq('id', id).maybeSingle();
        if (own && !cancelled) { setDream(own); d = own; }
      }
      if (!d || !uid || d.user_id !== uid) { if (!cancelled) setPremium(false); return; }
      if (cancelled) return;
      setIsOwner(true);

      const upgraded = new URLSearchParams(window.location.search).has('upgraded');
      if (upgraded) say('Welcome to Premium ✦');
      // Stripe tells us about a new payment a few seconds after checkout, so keep checking briefly.
      for (let i = 0; i < (upgraded ? 8 : 1); i++) {
        const { data: profile } = await supabase.from('profiles').select('plan, subscription_status').eq('user_id', uid).maybeSingle();
        const ok = profile?.plan === 'premium' && ACTIVE.includes(profile?.subscription_status);
        if (ok || i === (upgraded ? 7 : 0)) { if (!cancelled) setPremium(ok); break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
      const { data: r } = await supabase.from('dream_readings').select('*').eq('dream_id', id).maybeSingle();
      if (r && !cancelled) setReading(r);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // While the scenes are being animated, check every few seconds and swap the clips in.
  useEffect(() => {
    if (!isOwner || dream?.video_status !== 'animating') return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await api(`/api/dreams/${id}/video`, { method: 'GET' });
        if (stop) return;
        setDream((x) => ({ ...x, scenes: d.scenes, video_status: d.video_status }));
        if (d.video_status === 'ready') say('Your dream is moving ✦');
        if (d.video_status === 'animating') setTimeout(tick, 8000);
      } catch { if (!stop) setTimeout(tick, 15000); }
    };
    const t = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(t); };
  }, [isOwner, dream?.video_status, id, say]);

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

  async function share() {
    const url = window.location.origin + `/d/${id}`;
    const text = `${dream?.title || 'My dream'} — painted from my dream last night 🌙`;
    if (navigator.share) { try { await navigator.share({ title: 'Dream Reel', text, url }); } catch {} }
    else { await navigator.clipboard.writeText(url); say('Link copied'); }
  }

  if (!dream) {
    return (
      <main className="app">
        <div className="create-top"><a href="/" className="iconbtn" aria-label="Back">←</a></div>
        <div className="empty"><h2>This dream isn't here</h2><p className="lead">It may be private, or the link is wrong.</p></div>
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

  const moving = dream.scenes?.filter((s) => s.video_url).length || 0;

  return (
    <main className="app" style={{ gap: 14 }}>
      <div className="create-top">
        <a href="/gallery" className="iconbtn" aria-label="Back">←</a>
        <div className="center"><div className="eyebrow accent">{dreamDate(dream.created_at)}</div></div>
        <span className="iconbtn" aria-hidden="true">◎</span>
      </div>
      <h2 className="center">{dream.title}</h2>
      <Player scenes={dream.scenes} date={date} summary={isOwner && premium ? reading?.summary || null : null} />

      {isOwner && dream.video_status === 'animating' && (
        <div className="pill live center-pill"><i /> Bringing your scenes to life… {moving}/{dream.scenes.length}</div>
      )}
      {isOwner && premium && !dream.video_status && (
        <button className="btn block" onClick={animate}>✦ Bring this dream to life (moving video)</button>
      )}
      {isOwner && premium && dream.video_status === 'failed' && (
        <button className="btn block" onClick={animate}>↻ Try the moving video again</button>
      )}
      {animError && <div className="error">{animError}</div>}

      <div className="actions">
        <button className="btn primary" id="share" onClick={share}>⤴ Share</button>
        <a className="btn" href="/create">✦ New dream</a>
      </div>
      {dream.transcript && <p className="transcript">“{dream.transcript}”</p>}
      {isOwner && <GuruPanel dream={dream} premium={premium} reading={reading} onReading={onReading} />}
      <div className={`toast ${toast ? 'on' : ''}`}>{toast}</div>
    </main>
  );
}
