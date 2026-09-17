'use client';

import { useEffect, useState } from 'react';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { getName, greeting, stamp } from '@/lib/profile';
import DreamCard from '@/components/DreamCard';

export default function Home() {
  const [name, setName] = useState('');
  const [when, setWhen] = useState('');
  const [hello, setHello] = useState('Good morning,');
  const [recent, setRecent] = useState(null);

  useEffect(() => {
    setName(getName());
    setWhen(stamp());
    setHello(greeting());
    (async () => {
      const session = await ensureSession();
      const { data } = await getBrowserSupabase()
        .from('dreams')
        .select('id, title, created_at, status, scenes, style')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(6);
      setRecent(data || []);
    })().catch(() => setRecent([]));
  }, []);

  return (
    <main className="app">
      <div className="greet-row">
        <div>
          <div className="eyebrow">{when}</div>
          <h1 style={{ marginTop: 10 }}>{hello}<br /><span className="grad-text">{name || 'dreamer'}</span></h1>
        </div>
        <a href="/profile" className="avatar" aria-label="Profile">🐘</a>
      </div>

      <div className="hero">
        <p className="lead">Your night is still warm.</p>
        <h2>Catch the dream before it fades</h2>
      </div>

      <div className="mic-wrap">
        <div className="mic-ring">
          <a className="mic-btn" href="/create" id="go-record" style={{ textDecoration: 'none' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>
            Tap to record
            <small>30 seconds</small>
          </a>
        </div>
        <p className="lead">A quiet ritual for your waking mind</p>
      </div>

      <div>
        <div className="eyebrow accent">Your night sky</div>
        <div className="section-head" style={{ marginTop: 6 }}>
          <h2>Recent dreams</h2>
          <a href="/gallery">See all →</a>
        </div>
      </div>
      {recent && recent.length > 0 && (
        <div className="strip">
          {recent.map((d) => <DreamCard key={d.id} dream={d} big />)}
        </div>
      )}
      {recent && recent.length === 0 && (
        <p className="lead">Nothing here yet. Your first reel will appear right here.</p>
      )}
    </main>
  );
}
