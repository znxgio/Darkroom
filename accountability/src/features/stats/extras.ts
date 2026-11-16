// The one place the stats screens, the missed-reason gate and the weekly review get
// "extra" daily requirements that aren't tasks (e.g. daily photos).
import type { Backend } from '../../data/backend';
import type { Day } from '../../lib/dates';
import type { ExtraRequirement } from '../../lib/schedule';

/** Extra requirements that apply between `from` and `to`. None are wired in yet. */
export async function loadExtras(_b: Backend, _from: Day, _to: Day): Promise<ExtraRequirement[]> {
  return [];
}

const LABELS: Record<string, string> = {
  photos: 'Daily photo',
};

/** Display name for an extra requirement key. */
export function extraLabel(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
}
