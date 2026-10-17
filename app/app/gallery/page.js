'use client';

import { useEffect, useMemo, useState } from 'react';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { DreamTile, loadReels, withCovers } from '@/components/DreamCard';
import { track } from '@/lib/analytics';
import { STYLES } from '@/lib/styles';

const FILTERS = [
  { key: 'all', label: 'All dreams' },
  { key: 'newest', label: 'Newest' },
  ...Object.entries(STYLES).map(([key, s]) => ({ key, label: s.label })),
];

export default function Gallery() {
  const [dreams, setDreams] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [reels, setReels] = useState({});

  useEffect(() => {
    (async () => {
      const session = await ensureSession();
      const { data } = await getBrowserSupabase()
        .from('dreams')
        .select('id, title, created_at, status, scenes, style, transcript')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(100);
      setDreams(data || []);
      withCovers(data || []).then(setDreams).catch(() => {});
      track('gallery_opened', { dreams: (data || []).length }, { onceKey: 'gallery' });
      setReels(await loadReels(getBrowserSupabase(), (data || []).map((d) => d.id)));
    })().catch(() => setDreams([]));
  }, []);

  const shown = useMemo(() => {
    if (!dreams) return [];
    let list = dreams;
    if (filter === 'newest') list = list.slice(0, 6);
    else if (filter !== 'all') list = list.filter((d) => d.style === filter);
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((d) => (d.title || '').toLowerCase().includes(s) || (d.transcript || '').toLowerCase().includes(s) || (d.scenes || []).some((sc) => (sc.caption || '').toLowerCase().includes(s)));
    return list;
  }, [dreams, q, filter]);

  return (
    <main className="app">
      <div className="greet-row">
        <div>
          <div className="eyebrow accent">Archive</div>
          <h1 style={{ marginTop: 8 }}>Dream Gallery</h1>
        </div>
        <span className="iconbtn" aria-hidden="true">⏷</span>
      </div>

      <label className="search">
        <span aria-hidden="true">○</span>
        <input id="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by symbols, feelings, keywords…" />
      </label>

      <div className="chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>

      <div className="count-row">
        <span>Showing {shown.length} dream reel{shown.length === 1 ? '' : 's'}</span>
        <b>Newest first ⌄</b>
      </div>

      {dreams === null && <p className="lead">Loading…</p>}
      {dreams && dreams.length === 0 && (
        <div className="empty">
          <h2>No dreams yet</h2>
          <p className="lead">Tomorrow morning, tell it what you saw.</p>
          <a className="btn primary" href="/create">Record one now</a>
        </div>
      )}
      {shown.length > 0 && (
        <div className="grid">
          {shown.map((d) => <DreamTile key={d.id} dream={d} reel={reels[d.id]} />)}
        </div>
      )}
    </main>
  );
}
