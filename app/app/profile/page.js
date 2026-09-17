'use client';

import { useEffect, useState } from 'react';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { getName, setName as saveName } from '@/lib/profile';

export default function Profile() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState({ total: 0, streak: 0, week: 0 });

  useEffect(() => {
    setName(getName());
    (async () => {
      const session = await ensureSession();
      const { data } = await getBrowserSupabase().from('dreams').select('created_at, status').eq('user_id', session.user.id).eq('status', 'ready').order('created_at', { ascending: false });
      const list = data || [];
      const days = new Set(list.map((d) => new Date(d.created_at).toDateString()));
      let streak = 0; const cur = new Date();
      while (days.has(cur.toDateString())) { streak++; cur.setDate(cur.getDate() - 1); }
      const weekAgo = Date.now() - 7 * 86400000;
      setStats({ total: list.length, streak, week: list.filter((d) => new Date(d.created_at) > weekAgo).length });
    })().catch(() => {});
  }, []);

  function save(e) {
    e.preventDefault();
    saveName(name.trim());
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  }

  return (
    <main className="app">
      <div className="greet-row">
        <div>
          <div className="eyebrow accent">You</div>
          <h1 style={{ marginTop: 8 }}>{name || 'Dreamer'}</h1>
        </div>
        <span className="avatar" aria-hidden="true">🐘</span>
      </div>

      <div className="stat-row">
        <div className="stat"><b>{stats.total}</b><span>Dreams</span></div>
        <div className="stat"><b>{stats.streak}</b><span>Day streak</span></div>
        <div className="stat"><b>{stats.week}</b><span>This week</span></div>
      </div>

      <form onSubmit={save} className="field">
        <label htmlFor="name">What should we call you?</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" maxLength={24} />
        <button className="btn primary" type="submit" style={{ marginTop: 8 }}>{saved ? 'Saved ✓' : 'Save'}</button>
      </form>

      <div className="list">
        <div><span>Plan</span>Free · 3 dreams a day</div>
        <div><span>Reels</span>Saved for 30 days on Free</div>
        <a href="/gallery"><span>Your dreams</span>Open gallery →</a>
      </div>
      <p className="lead" style={{ fontSize: 13 }}>Your reels are tied to this phone and browser. Premium (coming soon) adds a login so you can keep them forever and open them anywhere.</p>
    </main>
  );
}
