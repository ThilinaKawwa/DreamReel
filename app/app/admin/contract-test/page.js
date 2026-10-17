'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

// Admin-only provider contract checks (the API returns 404 for everyone else).
export default function ContractTest() {
  const [out, setOut] = useState({});
  const [busy, setBusy] = useState('');

  async function call(key, body) {
    setBusy(key);
    try { setOut((o) => ({ ...o, [key]: null })); const r = await api('/api/admin/contract-test', { json: body }); setOut((o) => ({ ...o, [key]: r })); }
    catch (e) { setOut((o) => ({ ...o, [key]: { error: e.message, status: e.status } })); }
    setBusy('');
  }
  const falId = out.fal?.request_id;

  return (
    <main className="app" style={{ gap: 14 }}>
      <h2>Provider contract test</h2>
      <p className="fine" style={{ textAlign: 'left' }}>Tiny paid checks before generating full reels. Admins only.</p>
      <button className="btn primary" disabled={!!busy} onClick={() => call('openai', { check: 'openai', confirm: true })}>
        {busy === 'openai' ? 'Running…' : '1. OpenAI speech + transcription (~$0.01)'}
      </button>
      <button className="btn primary" disabled={!!busy} onClick={() => call('fal', { check: 'fal', confirm: true })}>
        {busy === 'fal' ? 'Submitting…' : '2. fal Kling O1 — one 5 s clip (~$0.56)'}
      </button>
      <button className="btn" disabled={!!busy || !falId} onClick={() => call('falStatus', { check: 'fal-status', requestId: falId })}>
        {busy === 'falStatus' ? 'Checking…' : '3. Check the O1 clip (repeat until completed)'}
      </button>
      {['openai', 'fal', 'falStatus'].map((k) => out[k] && (
        <pre key={k} style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--surface)', padding: 12, borderRadius: 12 }}>
          {k}: {JSON.stringify(out[k], null, 2)}
        </pre>
      ))}
      {out.falStatus?.output_url && <video src={out.falStatus.output_url} controls playsInline style={{ width: '100%', borderRadius: 12 }} />}
    </main>
  );
}
