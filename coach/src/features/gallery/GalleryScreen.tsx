import { useState } from 'react';
import type { PhotoWithCritiques } from '../../data/types';
import { formatScore, scoreClass } from '../critique/CritiqueView';

type Filter = 'all' | 'critiqued' | 'live' | 'import';
type Sort = 'new' | 'best';

export function GalleryScreen({ photos, onOpen }: { photos: PhotoWithCritiques[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('new');
  let list = photos.filter((p) =>
    filter === 'all' ? true : filter === 'critiqued' ? p.critiques.length > 0 : p.source === filter,
  );
  if (sort === 'best') list = [...list].sort((a, b) => (b.critiques[0]?.score ?? 0) - (a.critiques[0]?.score ?? 0));

  return (
    <div className="screen">
      <h1>Gallery</h1>
      <div className="filters" role="group" aria-label="Filter">
        {(
          [
            ['all', 'All'],
            ['critiqued', 'Critiqued'],
            ['live', 'Live shots'],
            ['import', 'Imported'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`chip${filter === k ? ' is-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
        <button className="chip chip-sort" onClick={() => setSort(sort === 'new' ? 'best' : 'new')}>
          {sort === 'new' ? 'Newest' : 'Best'} ⇅
        </button>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <strong>No photos yet</strong>
          <span>Shoot with the live coach or pick a photo to critique. Only small previews are kept here.</span>
        </div>
      ) : (
        <ul className="grid">
          {list.map((p) => (
            <li key={p.id}>
              <button onClick={() => onOpen(p.id)} aria-label={p.critiques[0] ? `Photo, score ${p.critiques[0].score}` : 'Photo, no critique'}>
                <img src={p.thumb} alt="" loading="lazy" />
                {p.critiques[0] && <span className={`badge ${scoreClass(p.critiques[0].score)}`}>{formatScore(p.critiques[0].score)}</span>}
                {p.source === 'live' && <span className="badge-live">LIVE</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
