'use client';

import { useState } from 'react';
import { track } from '@/lib/analytics';
import { GURU_NAME } from '@/lib/guru-public';

export const ONBOARDED_KEY = 'dreamreel.onboarded';

/** Three short screens for a brand-new person: meet Orin, privacy, microphone. */
export default function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [micNote, setMicNote] = useState('');

  function finish(mic) {
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch {}
    track('onboarding_completed', { mic });
    onDone();
  }

  async function allowMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      finish(true);
    } catch {
      setMicNote('No problem — you can type to him, or allow the microphone later in your browser settings.');
    }
  }

  return (
    <main className="onboard" aria-live="polite">
      <div className="onboard-dots" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i === step ? 'on' : ''} />)}</div>
      {step === 0 && (
        <section>
          <img className="onboard-portrait" src="/orin-avatar-256.jpg" alt="" width={140} height={140} />
          <h1>Meet {GURU_NAME}</h1>
          <p className="lead">Tell {GURU_NAME} what you remember. He helps you capture and explore your dreams over time.</p>
          <button className="btn primary block" onClick={() => setStep(1)}>Continue</button>
        </section>
      )}
      {step === 1 && (
        <section>
          <div className="onboard-icon" aria-hidden="true">🔒</div>
          <h1>Your dreams are personal</h1>
          <p className="lead">Your dream archive is private to you. Nothing you tell {GURU_NAME} is shared unless you choose to share a Dream Reel.</p>
          <button className="btn primary block" onClick={() => setStep(2)}>Continue</button>
        </section>
      )}
      {step === 2 && (
        <section>
          <div className="onboard-icon" aria-hidden="true">🎙</div>
          <h1>Talk, half-awake</h1>
          <p className="lead">Dreams fade fast. Speaking is the quickest way to catch one — messy is fine.</p>
          <button className="btn primary block" onClick={allowMic}>Allow microphone</button>
          {micNote && <p className="fine">{micNote}</p>}
          <button className="linkbtn" onClick={() => finish(false)}>{micNote ? 'Continue' : 'Not now — I’ll type'}</button>
        </section>
      )}
    </main>
  );
}
