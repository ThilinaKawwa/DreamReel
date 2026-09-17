import { dreamDate } from '@/lib/profile';

export default function DreamCard({ dream, big }) {
  const cover = dream.scenes?.[0]?.image_url;
  const ready = dream.status === 'ready';
  return (
    <a href={`/d/${dream.id}`} className={`card ${ready ? '' : 'pending'}`} aria-label={dream.title || 'Dream'}>
      {cover && <img src={cover} alt="" loading="lazy" />}
      <div className="fade" />
      <span className="dur">{ready ? '0:23' : dream.status === 'failed' ? 'failed' : '…'}</span>
      {ready && <span className="play" aria-hidden="true" />}
      <div className="title" style={big ? { fontSize: 30 } : undefined}>{dream.title || 'Untitled dream'}</div>
    </a>
  );
}

export function DreamTile({ dream, onShare }) {
  return (
    <div className="tile">
      <DreamCard dream={dream} />
      <div>
        <h3>{dream.title || 'Untitled dream'}</h3>
        <div className="meta">{dreamDate(dream.created_at)}{dream.style ? ` · ${dream.style}` : ''}</div>
      </div>
      <div className="foot">
        <button onClick={() => onShare(dream)}>⤴ Share</button>
        <a href={`/d/${dream.id}`} style={{ textDecoration: 'none' }}>•••</a>
      </div>
    </div>
  );
}
