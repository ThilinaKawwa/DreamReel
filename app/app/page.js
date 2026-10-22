'use client';

import { useEffect, useState } from 'react';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase';
import { api } from '@/lib/api';
import { track, noteVisit } from '@/lib/analytics';
import GuruScreen from '@/components/GuruScreen';
import Onboarding, { ONBOARDED_KEY } from '@/components/Onboarding';

/** Home is Orin. Everything else (My Dreams, Visual Memories, Insights) is one tap away. */
export default function Home() {
  const [ready, setReady] = useState(false);
  const [onboard, setOnboard] = useState(false);
  const [hasDreams, setHasDreams] = useState(true);
  const [dreamId, setDreamId] = useState(null);
  const [dreamTitle, setDreamTitle] = useState(null);

  useEffect(() => {
    (async () => {
      const about = new URLSearchParams(window.location.search).get('dream');
      const session = await ensureSession();
      const supabase = getBrowserSupabase();
      const { count } = await supabase.from('dreams').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id);
      const any = (count || 0) > 0;
      setHasDreams(any);
      let seen = false;
      try { seen = Boolean(localStorage.getItem(ONBOARDED_KEY)); if (any && !seen) localStorage.setItem(ONBOARDED_KEY, '1'); } catch {}
      setOnboard(!any && !seen);
      if (about && /^[0-9a-f-]{36}$/i.test(about)) {
        const { data } = await supabase.from('dreams').select('id, title').eq('id', about).eq('user_id', session.user.id).maybeSingle();
        if (data) { setDreamId(data.id); setDreamTitle(data.title || 'Your dream'); }
      }
      track('landing_view', { dreams: count || 0 }, { onceKey: 'landing' });
      noteVisit();
      // Quietly build any missing dream memories (including dreams from before Dream Guru V2).
      if (any) api('/api/memory/sync', { json: {} }).catch(() => {});
      setReady(true);
    })().catch(() => setReady(true));
  }, []);

  if (!ready) return <main className="guru-home"><p className="lead center">…</p></main>;
  if (onboard) return <Onboarding onDone={() => setOnboard(false)} />;
  return (
    <GuruScreen
      key={dreamId || 'home'}
      dreamId={dreamId}
      dreamTitle={dreamTitle}
      greeting={dreamId ? `What would you like to explore about this dream?` : greetingFor(hasDreams)}
    />
  );
}

function greetingFor(hasDreams) {
  const h = new Date().getHours();
  if (!hasDreams) return h >= 4 && h < 12 ? 'Morning. Tell me anything you remember — even if it’s only a fragment.' : 'Tell me anything you remember — even if it’s only a fragment.';
  return h >= 4 && h < 12 ? 'Morning. What do you remember?' : 'What do you remember?';
}
