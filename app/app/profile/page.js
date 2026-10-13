'use client';

import { useEffect, useState } from 'react';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { getName, setName as saveName } from '@/lib/profile';
import { api, startPremium } from '@/lib/api';
import { GURU_NAME, PREMIUM_PRICE_LABEL, TRADITION_OPTIONS } from '@/lib/guru-public';

const ACTIVE = ['active', 'trialing'];

export default function Profile() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState({ total: 0, streak: 0, week: 0 });
  const [userId, setUserId] = useState(null);
  const [email, setEmail] = useState('');
  const [isAnon, setIsAnon] = useState(true);
  const [plan, setPlan] = useState(null);
  const [tradition, setTradition] = useState('blend');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const premium = plan?.plan === 'premium' && ACTIVE.includes(plan?.subscription_status);

  useEffect(() => {
    setName(getName());
    (async () => {
      const session = await ensureSession();
      const supabase = getBrowserSupabase();
      const user = session.user;
      setUserId(user.id);
      setIsAnon(Boolean(user.is_anonymous));
      setEmail(user.email || user.new_email || '');

      const upgraded = new URLSearchParams(window.location.search).has('upgraded');
      // Stripe confirms a new payment a few seconds after checkout, so keep checking briefly.
      for (let i = 0; i < (upgraded ? 8 : 1); i++) {
        const { data: p } = await supabase.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
        setPlan(p || { plan: 'free' });
        if (p?.guru_tradition) setTradition(p.guru_tradition);
        if (!upgraded || (p?.plan === 'premium' && ACTIVE.includes(p.subscription_status))) break;
        await new Promise((r) => setTimeout(r, 2500));
      }

      const { data } = await supabase.from('dreams').select('created_at, status').eq('user_id', user.id).eq('status', 'ready').order('created_at', { ascending: false });
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

  function flash(m) { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 4000); }

  async function upgrade() {
    setBusy(true); setErr('');
    try { await startPremium('/profile'); } catch (e) { setErr(e.message); setBusy(false); }
  }

  async function manage() {
    setBusy(true); setErr('');
    try { const { url } = await api('/api/billing/portal'); window.location.href = url; }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  async function chooseTradition(key) {
    setTradition(key);
    const supabase = getBrowserSupabase();
    const now = new Date().toISOString();
    const { error } = plan?.user_id
      ? await supabase.from('profiles').update({ guru_tradition: key, updated_at: now }).eq('user_id', userId)
      : await supabase.from('profiles').insert({ user_id: userId, guru_tradition: key });
    if (error) setErr('Could not save that choice.');
    else { if (!plan?.user_id) setPlan((p) => ({ ...p, user_id: userId })); flash(`${GURU_NAME} will read through: ${TRADITION_OPTIONS.find((t) => t.key === key).label}`); }
  }

  // Turns this phone's anonymous account into one tied to an email, so it can be opened anywhere.
  async function keepAccount(e) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setBusy(true); setErr('');
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.updateUser({ email: addr }, { emailRedirectTo: `${window.location.origin}/profile` });
    setBusy(false);
    if (error) setErr(error.message);
    else flash('Check your inbox and tap the link to confirm.');
  }

  // Opens an existing account on a new phone.
  async function signIn() {
    const addr = email.trim();
    if (!addr) { setErr('Type your email first.'); return; }
    setBusy(true); setErr('');
    const { error } = await getBrowserSupabase().auth.signInWithOtp({
      email: addr,
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/profile` },
    });
    setBusy(false);
    if (error) setErr(error.message);
    else flash('Sign-in link sent. Open it on this phone.');
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

      <section className={`plan-card ${premium ? 'premium' : ''}`}>
        <div className="plan-head">
          <img className="guru-avatar" src="/orin-avatar-256.jpg" alt="" width={56} height={56} />
          <div>
            <div className="eyebrow accent">{premium ? 'Premium ✦' : 'Free plan'}</div>
            <h3 style={{ marginTop: 4 }}>{premium ? `${GURU_NAME} is yours` : `Meet ${GURU_NAME}, the Dream Guru`}</h3>
          </div>
        </div>
        {premium ? (
          <>
            <p className="lead">
              Guru readings, voice chat, dream memory and moving reels.
              {plan?.current_period_end && <> Renews {new Date(plan.current_period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.</>}
            </p>
            <button className="btn block" onClick={manage} disabled={busy}>Manage or cancel</button>
          </>
        ) : (
          <>
            <p className="lead">A wise reading of every dream, conversations by voice, a guide who remembers your dreams — and reels that truly move.</p>
            <button className="btn primary block" onClick={upgrade} disabled={busy || plan === null}>✦ Go Premium · {PREMIUM_PRICE_LABEL}</button>
          </>
        )}
      </section>

      <section className="field">
        <label>How should {GURU_NAME} read your dreams?</label>
        <div className="traditions">
          {TRADITION_OPTIONS.map((t) => (
            <button key={t.key} className={`style ${tradition === t.key ? 'on' : ''}`} onClick={() => chooseTradition(t.key)} aria-pressed={tradition === t.key} disabled={!userId}>
              <b>{t.label}</b><small>{t.blurb}</small>
            </button>
          ))}
        </div>
      </section>

      <form className="field" onSubmit={keepAccount}>
        <label htmlFor="email">{isAnon ? 'Keep your dreams safe' : 'Your account'}</label>
        {isAnon ? (
          <>
            <p className="lead" style={{ fontSize: 14 }}>
              Right now your dreams{premium ? ' and Premium' : ''} live only on this phone. Add your email to keep them forever and open them anywhere.
            </p>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            <button className="btn primary" type="submit" disabled={busy || !email.trim()} style={{ marginTop: 8 }}>Save my account</button>
            <button className="btn" type="button" onClick={signIn} disabled={busy} style={{ marginTop: 4 }}>I already have an account — sign in</button>
          </>
        ) : (
          <div className="list"><div><span>Email</span>{email}</div></div>
        )}
      </form>

      {msg && <div className="pill">{msg}</div>}
      {err && <div className="error">{err}</div>}

      <div className="list">
        <div><span>Plan</span>{premium ? 'Premium · moving reels' : 'Free · 3 dreams a day'}</div>
        <a href="/gallery"><span>Your dreams</span>Open gallery →</a>
      </div>
    </main>
  );
}
