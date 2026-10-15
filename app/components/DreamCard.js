import { dreamDate } from '@/lib/profile';

/** "0:27" from seconds */
export function clock(seconds) {
  const s = Math.round(Number(seconds) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The little badge on a card: real film length, or what's happening — never a made-up number. */
function badge(dream, reel) {
  if (dream.status === 'failed') return 'failed';
  if (dream.status !== 'ready') return '…';
  if (reel?.status === 'completed' && reel.duration_seconds) return clock(reel.duration_seconds);
  if (reel?.status === 'queued' || reel?.status === 'processing') return 'making film';
  return null;
}

export default function DreamCard({ dream, reel, big }) {
  const cover = dream.scenes?.[0]?.image_url;
  const ready = dream.status === 'ready';
  const label = badge(dream, reel);
  return (
    <a href={`/d/${dream.id}`} className={`card ${ready ? '' : 'pending'}`} aria-label={dream.title || 'Dream'}>
      {cover && <img src={cover} alt="" loading="lazy" decoding="async" />}
      <div className="fade" />
      {label && <span className="dur">{label}</span>}
      {ready && <span className="play" aria-hidden="true" />}
      <div className="title" style={big ? { fontSize: 30 } : undefined}>{dream.title || 'Untitled dream'}</div>
    </a>
  );
}

export function DreamTile({ dream, reel }) {
  return (
    <div className="tile">
      <DreamCard dream={dream} reel={reel} />
      <div>
        <h3>{dream.title || 'Untitled dream'}</h3>
        <div className="meta">{dreamDate(dream.created_at)}{reel?.status === 'completed' ? ' · film ready' : ''}</div>
      </div>
      <div className="foot">
        <a href={`/d/${dream.id}`} style={{ textDecoration: 'none' }}>{reel?.status === 'completed' ? '▶ Watch · Share' : 'Open'}</a>
      </div>
    </div>
  );
}

/** Film status for a list of dreams (empty if films aren't switched on yet). */
export async function loadReels(supabase, ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase.from('dream_reels').select('dream_id, status, duration_seconds').in('dream_id', ids);
  if (error || !data) return {};
  return Object.fromEntries(data.map((r) => [r.dream_id, r]));
}
