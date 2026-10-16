// Local development only: runs a production in this process (no network hop).
import { getServiceSupabase } from '@/lib/server';
import { advanceProduction } from '@/lib/cinema/production';

const running = new Set();
export function runInline(dreamId) {
  if (running.has(dreamId)) return;
  running.add(dreamId);
  (async () => {
    try {
      const admin = getServiceSupabase();
      for (let i = 0; i < 40; i++) {
        const r = await advanceProduction(admin, dreamId, Date.now() + 265_000);
        if (r !== 'waiting') break;
      }
    } finally { running.delete(dreamId); }
  })();
}
