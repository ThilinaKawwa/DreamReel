'use client';

import { useEffect, useState } from 'react';
import { api, startPremium } from '@/lib/api';
import { track } from '@/lib/analytics';
import { GURU_NAME } from '@/lib/guru-public';

/** Insights — what repeats in the dream journal, counted from stored dreams. No charts. */
export default function Insights() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/api/memory/insights', { method: 'GET' }).then(setD).catch(() => setD({ empty: true })); }, []);

  const nothing = d && !d.empty && !d.people?.length && !d.places?.length && !d.themes?.length && !d.things?.length && !d.feeling;
  return (
    <main className="app">
      <div>
        <div className="eyebrow accent">From your journal</div>
        <h1 style={{ marginTop: 8 }}>Insights</h1>
      </div>
      {d === null && <p className="lead">Looking through your dreams…</p>}
      {(d?.empty || nothing) && (
        <div className="empty">
          <p className="lead">Patterns will appear as your dream journal grows.</p>
          <a className="btn" href="/">Tell {GURU_NAME} a dream</a>
        </div>
      )}
      {d && !d.empty && !nothing && (
        <>
          <p className="lead">
            {d.activity.week > 0 ? `This week you remembered ${d.activity.week} dream${d.activity.week === 1 ? '' : 's'}. ` : ''}
            {d.activity.total} in your journal so far.
          </p>
          <Group title="Recurring people" rows={d.people} />
          <Group title="Recurring places" rows={d.places} />
          <Group title="Things and creatures" rows={d.things} />
          <Group title="Themes" rows={d.themes} />
          {d.feeling && (
            <section className="insight">
              <h3>Feeling</h3>
              <p>Most frequent recent feeling: <b>{d.feeling.label}</b> <span className="muted">({d.feeling.dreams} of {d.feeling.of} dreams this month)</span></p>
            </section>
          )}
          {d.patterns?.length > 0 && (
            <section className="insight">
              <h3>What {GURU_NAME} has noticed</h3>
              <ul>{d.patterns.map((p) => <li key={p}>{p}</li>)}</ul>
            </section>
          )}
          {d.advancedLocked && d.upgradeAvailable && (
            <section className="insight muted-card">
              <p>Premium also shows the feelings that come with what recurs, and how they change over time.</p>
              <button className="btn small" onClick={() => { track('upgrade_clicked', { from: 'insights' }); startPremium().catch(() => {}); }}>See Premium</button>
            </section>
          )}
          <p className="fine">Counts from your saved dreams. Similar places or things may not be the same one each time.</p>
        </>
      )}
    </main>
  );
}

function Group({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <section className="insight">
      <h3>{title}</h3>
      <ul className="insight-rows">
        {rows.map((r) => <li key={r.label}><span>{r.label}</span><span className="muted">{r.dreams} dreams</span></li>)}
      </ul>
    </section>
  );
}
