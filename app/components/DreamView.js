'use client';

import { useEffect, useState } from 'react';
import Player from '@/components/Player';
import { getBrowserSupabase } from '@/lib/supabase';
import { dreamDate } from '@/lib/profile';

export default function DreamView({ dream: initial, id }) {
  const [dream, setDream] = useState(initial);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (dream) return;
    const supabase = getBrowserSupabase();
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const { data: own } = await supabase.from('dreams').select('*').eq('id', id).maybeSingle();
      if (own) setDream(own);
    });
  }, [id, dream]);

  function say(msg) { setToast(msg); setTimeout(() => setToast(''), 1800); }

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

  return (
    <main className="app" style={{ gap: 14 }}>
      <div className="create-top">
        <a href="/gallery" className="iconbtn" aria-label="Back">←</a>
        <div className="center"><div className="eyebrow accent">{dreamDate(dream.created_at)}</div></div>
        <span className="iconbtn" aria-hidden="true">◎</span>
      </div>
      <h2 className="center">{dream.title}</h2>
      <Player scenes={dream.scenes} date={date} />
      <div className="actions">
        <button className="btn primary" id="share" onClick={share}>⤴ Share</button>
        <a className="btn" href="/create">✦ New dream</a>
      </div>
      {dream.transcript && <p className="transcript">“{dream.transcript}”</p>}
      <div className={`toast ${toast ? 'on' : ''}`}>{toast}</div>
    </main>
  );
}
