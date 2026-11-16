// The one place the stats screens, the missed-reason gate and the weekly review get
// "extra" daily requirements that aren't tasks (e.g. daily photos).
import type { Backend } from '../../data/backend';
import type { Day } from '../../lib/dates';
import type { ExtraRequirement } from '../../lib/schedule';
import { photosApi, photosRequirement } from '../photos/api';
import { settingsApi } from '../settings/api';

/** Extra requirements that apply between `from` and `to`: daily photos (from settings.photos_from). */
export async function loadExtras(b: Backend, from: Day, to: Day): Promise<ExtraRequirement[]> {
  const s = await settingsApi(b).get();
  if (to < s.photos_from) return [];
  const complete = await photosApi(b).completeDays(from < s.photos_from ? s.photos_from : from, to);
  return [photosRequirement(s.photos_from, complete)];
}

const LABELS: Record<string, string> = {
  photos: 'Daily photos',
};

/** Display name for an extra requirement key. */
export function extraLabel(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
}
