'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { dreamDate } from '@/lib/profile';
import { GURU_NAME } from '@/lib/guru-public';

/** My Dreams — the private dream archive. */
export default function Dreams() {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);

  async function load(query = '') {
    const r = await api(`/api/memory/journal${query ? `?q=${encodeURIComponent(query)}` : ''}`, { method: 'GET' }).catch(() => ({ items: [] }));
    setItems(r.items || []);
    setSearching(false);
  }
  useEffect(() => { load(); track('gallery_opened', { view: 'journal' }, { onceKey: 'journal' }); }, []);

  function onSearch(v) {
    setQ(v);
    clearTimeout(timer.current);
    setSearching(true);
    timer.current = setTimeout(() => load(v.trim()), 450);
  }

  return (
    <main className="app">
      <div className="greet-row">
        <div>
          <div className="eyebrow accent">Private to you</div>
          <h1 style={{ marginTop: 8 }}>My Dreams</h1>
        </div>
        <a className="linkbtn small" href="/gallery">Visual Memories</a>
      </div>

      <label className="search">
        <span aria-hidden="true">○</span>
        <input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search: my brother, water, the station…" aria-label="Search your dreams" />
      </label>

      {items === null && <p className="lead">Opening your journal…</p>}
      {items && items.length === 0 && !q && (
        <div className="empty">
          <h2>No dreams yet</h2>
          <p className="lead">You haven’t saved any dreams yet. Tell {GURU_NAME} what you remember.</p>
          <a className="btn primary" href="/">Talk to {GURU_NAME}</a>
        </div>
      )}
      {items && items.length === 0 && q && !searching && <p className="lead">No dreams match “{q}”.</p>}

      {items && items.length > 0 && (
        <ul className="journal" aria-busy={searching}>
          {items.map((d) => (
            <li key={d.id}>
              <a className="journal-card" href={`/d/${d.id}`}>
                {d.cover ? <img src={d.cover} alt="" loading="lazy" /> : <span className="journal-moon" aria-hidden="true" />}
                <span className="journal-body">
                  <span className="journal-meta">{dreamDate(d.date)}{d.mood ? ` · ${d.mood}` : ''}</span>
                  <b>{d.title}</b>
                  {d.summary && <span className="journal-summary">{d.summary}</span>}
                  <span className="journal-flags">
                    {d.talked && <span title={`Talked with ${GURU_NAME}`}>☾ {GURU_NAME}</span>}
                    {d.visual && <span title="Dream Reel">{d.making ? '◌ making reel' : '▶ reel'}</span>}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
