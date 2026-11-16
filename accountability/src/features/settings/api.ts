import type { Backend } from '../../data/backend';
import { demoStore } from '../../data/backend';
import type { Day } from '../../lib/dates';

export interface Settings {
  photos_from: Day;
  photo_reminder_time: string | null; // 'HH:MM'
  stakes_enabled: boolean;
  stakes_scope: 'critical' | 'any';
  stakes_name: string | null;
  stakes_email: string | null;
  stakes_channel: 'email';
  nudge_time: string | null; // 'HH:MM'
  my_name: string | null;
  stakes_since: Day | null;
}

export type SettingsPatch = Partial<Omit<Settings, 'photos_from' | 'stakes_since'>>;

const COLS =
  'photos_from,photo_reminder_time,stakes_enabled,stakes_scope,stakes_name,stakes_email,stakes_channel,nudge_time,my_name,stakes_since';

function norm(r: any): Settings {
  const hm = (v: unknown) => (v ? String(v).slice(0, 5) : null);
  return { ...r, photo_reminder_time: hm(r.photo_reminder_time), nudge_time: hm(r.nudge_time) };
}

export function settingsApi(b: Backend) {
  if (b.supabase) {
    const sb = b.supabase;
    return {
      async get(): Promise<Settings> {
        const { data, error } = await sb.from('settings').select(COLS).maybeSingle();
        if (error) throw new Error(error.message);
        if (data) return norm(data);
        const ins = await sb.from('settings').insert({}).select(COLS).single();
        if (ins.error) throw new Error(ins.error.message);
        return norm(ins.data);
      },
      async update(patch: SettingsPatch): Promise<Settings> {
        const { data: u } = await sb.auth.getUser();
        const { data, error } = await sb
          .from('settings')
          .update(patch)
          .eq('user_id', u.user?.id ?? '')
          .select(COLS)
          .single();
        if (error) throw new Error(error.message);
        return norm(data);
      },
    };
  }
  const store = demoStore<Settings | null>(b, 'settings', null);
  return {
    async get(): Promise<Settings> {
      let s = store.read();
      if (!s) {
        s = {
          photos_from: await b.repo.today(),
          photo_reminder_time: '08:00',
          stakes_enabled: false,
          stakes_scope: 'critical',
          stakes_name: null,
          stakes_email: null,
          stakes_channel: 'email',
          nudge_time: '21:00',
          my_name: null,
          stakes_since: null,
        };
        store.write(s);
      }
      return s;
    },
    async update(patch: SettingsPatch): Promise<Settings> {
      const cur = await this.get();
      const s = { ...cur, ...patch };
      if (patch.stakes_enabled && !cur.stakes_enabled) s.stakes_since = await b.repo.today();
      store.write(s);
      return s;
    },
  };
}

export type SettingsApi = ReturnType<typeof settingsApi>;
