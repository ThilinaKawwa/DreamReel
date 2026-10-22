'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, startPremium } from '@/lib/api';
import { track } from '@/lib/analytics';
import { dreamDate } from '@/lib/profile';
import { GURU_NAME } from '@/lib/guru-public';
import { GuruInvite } from '@/components/GuruScreen';
import { STAGE_WORDS } from '@/components/ReelHero';

/**
 * The owner's view of one dream as a memory: the story, their own words, who and what was in
 * it, Orin's reflection, related dreams — and, if they want, a Dream Reel.
 */
export default function DreamMemory({ id, hasScenes, onTitle }) {
  const [d, setD] = useState(null);
  const [showWords, setShowWords] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', transcript: '' });
  const [reel, setReel] = useState(null);   // visualize progress (dreams without pictures yet)
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const r = await api(`/api/dreams/${id}`, { method: 'GET' }).catch((e) => ({ error: e.message }));
    setD(r);
    return r;
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // While the memory is being written (just after capture or an edit), check back briefly.
  useEffect(() => {
    if (!d || d.error || d.memoryStatus === 'ready' || d.memoryStatus === 'failed') return;
    const t = setTimeout(load, 6000);
    return () => clearTimeout(t);
  }, [d, load]);

  // Is a Dream Reel being made for this saved dream?
  const pollReel = useCallback(async () => {
    const r = await api(`/api/dreams/${id}/reel`, { method: 'GET' }).catch(() => null);
    if (!r) return null;
    setReel(r);
    if (r.dreamReady || r.status === 'completed') window.location.reload();
    return r;
  }, [id]);
  useEffect(() => { if (!hasScenes) pollReel(); }, [hasScenes, pollReel]);
  const making = reel && (reel.status === 'processing' || reel.status === 'queued');
  useEffect(() => {
    if (!making) return;
    const t = setInterval(pollReel, 4000);
    return () => clearInterval(t);
  }, [making, pollReel]);

  async function visualize() {
    setBusy('visualize'); setErr(null);
    try {
      const r = await api(`/api/dreams/${id}/visualize`, { json: {} });
      if (r.mode === 'image_fallback') window.location.reload();
      else await pollReel();
    } catch (e) { setErr({ message: e.message, upgrade: e.upgrade }); }
    setBusy('');
  }

  async function retryReel() {
    setReel({ status: 'processing', stage: null });
    const r = await api(`/api/dreams/${id}/reel`, { json: { retry: true } }).catch((e) => ({ status: 'failed', error: e.message, canRetry: false }));
    setReel(r);
  }

  async function save(e) {
    e.preventDefault();
    setBusy('save'); setErr(null);
    try {
      await api(`/api/dreams/${id}`, { method: 'PATCH', json: { title: draft.title, transcript: draft.transcript } });
      setEditing(false);
      onTitle?.(draft.title);
      await load();
    } catch (e2) { setErr({ message: e2.message }); }
    setBusy('');
  }

  async function remove() {
    if (!window.confirm('Delete this dream? Its memory, its conversation with Orin and any Dream Reel go with it. This can’t be undone.')) return;
    setBusy('delete');
    try {
      await api(`/api/dreams/${id}`, { method: 'DELETE' });
      window.location.href = '/dreams';
    } catch (e) { setErr({ message: e.message }); setBusy(''); }
  }

  if (!d) return <p className="lead center">Opening this dream…</p>;
  if (d.error) return <div className="error">{d.error}</div>;
  const m = d.memory;
  const people = d.entities.filter((e) => e.type === 'person');
  const places = d.entities.filter((e) => e.type === 'place');
  const things = d.entities.filter((e) => e.type === 'object' || e.type === 'creature');

  return (
    <div className="memory">
      {!hasScenes && (
        <section className="memory-visual">
          {making ? (
            <p className="lead" role="status"><span className="orb small" aria-hidden="true" /> {STAGE_WORDS[reel.stage] || 'Creating your Dream Reel…'} You can leave — it keeps going.</p>
          ) : reel?.status === 'failed' ? (
            <div>
              <p className="lead">{reel.error || 'The Dream Reel didn’t finish.'} Your dream is still saved.</p>
              {reel.canRetry && <button className="btn" onClick={retryReel}>Try again</button>}
            </div>
          ) : d.canVisualize ? (
            <button className="btn block" onClick={visualize} disabled={busy === 'visualize'}>{busy === 'visualize' ? 'Starting…' : '✦ Visualize this dream'}</button>
          ) : null}
        </section>
      )}

      {editing ? (
        <form className="memory-edit" onSubmit={save}>
          <label className="label" htmlFor="t">Title</label>
          <input id="t" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={80} />
          <label className="label" htmlFor="w">Your words</label>
          <textarea id="w" value={draft.transcript} onChange={(e) => setDraft({ ...draft, transcript: e.target.value })} rows={8} maxLength={8000} />
          <div className="row-actions">
            <button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button type="button" className="linkbtn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <p className="fine">{GURU_NAME} will update his memory of this dream.</p>
        </form>
      ) : (
        <>
          <section>
            <h3 className="memory-h">The dream</h3>
            {m?.cleaned_text ? <p className="memory-story">{m.cleaned_text}</p>
              : <p className="lead">{d.memoryStatus === 'failed' ? 'Your words are saved below.' : `${GURU_NAME} is writing this into your journal…`}</p>}
            <button className="linkbtn small" onClick={() => setShowWords((v) => !v)} aria-expanded={showWords}>{showWords ? 'Hide your original words' : 'Your original words'}</button>
            {showWords && <p className="transcript">“{d.dream.transcript}”</p>}
          </section>

          {(people.length > 0 || places.length > 0 || things.length > 0 || m?.emotions?.length > 0) && (
            <section className="memory-facts">
              <Chips title="People" rows={people} />
              <Chips title="Places" rows={places} />
              <Chips title="Important elements" rows={things} />
              {m?.emotions?.length > 0 && (<div><span className="label">Feeling</span><div className="tags">{m.emotions.map((x) => <span key={x}>{x}</span>)}</div></div>)}
            </section>
          )}

          {m?.reflection && (
            <section className="memory-reflection">
              <h3 className="memory-h">{GURU_NAME}’s reflection</h3>
              <p>{m.reflection}</p>
            </section>
          )}

          {d.related.length > 0 && (
            <section>
              <h3 className="memory-h">Related dreams</h3>
              <ul className="related">
                {d.related.map((r) => (
                  <li key={r.id}><a href={`/d/${r.id}`} onClick={() => track('related_dream_opened', { from: 'dream' })}><b>{r.title}</b><span>{r.because} · {dreamDate(r.date)}</span></a></li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {err && (
        <div className="error">{err.message}{err.upgrade && <> <button className="linkbtn small" onClick={() => startPremium().catch(() => {})}>See Premium</button></>}</div>
      )}

      <GuruInvite dreamId={id} />
      {!editing && (
        <div className="reel-secondary">
          <button className="linkbtn" onClick={() => { setDraft({ title: d.dream.title || m?.title || '', transcript: d.dream.transcript || '' }); setEditing(true); }}>Edit</button>
          <span aria-hidden="true">·</span>
          <button className="linkbtn" onClick={remove} disabled={busy === 'delete'}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
        </div>
      )}
    </div>
  );
}

function Chips({ title, rows }) {
  if (!rows.length) return null;
  return (
    <div>
      <span className="label">{title}</span>
      <div className="tags">
        {rows.map((r) => <span key={r.label} title={r.dreams > 1 ? `In ${r.dreams} of your dreams${r.sure ? '' : ' (maybe not the same one each time)'}` : undefined}>{r.label}{r.dreams > 1 ? ` · ${r.dreams}` : ''}</span>)}
      </div>
    </div>
  );
}
