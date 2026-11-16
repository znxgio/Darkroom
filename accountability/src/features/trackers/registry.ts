// TRACKERS: optional daily logs (weight, notes, sleep, …). They are NOT required
// items: they never affect streaks, the calendar or the weekly score.
//
// HOW TO ADD A TRACKER
//   1. Add one object to TRACKERS below. For numbers use numberTracker({...}),
//      for free text use textTracker({...}). That's it: the Today card, the
//      detail screen (chart + history), storage and the no-backfill rules all
//      come for free.
//   2. Optional: give it its own `entryComponent` (how today's value is typed in)
//      or `summaryComponent` (what the Today card shows once logged).
//   - `key` is permanent (it's stored with every entry): lowercase letters,
//     digits and _, starting with a letter (the database checks this).
//   - Storage: one row per tracker per day in `tracker_entries`, value is jsonb:
//     number trackers store { v: number }, text trackers store { text: string }.
//   - Only today can be written or changed; past days are locked in the database.
import type { ComponentType } from 'react';
import type { Day } from '../../lib/dates';

export type TrackerKind = 'number' | 'text';

export type TrackerValue = { v: number } | { text: string };

export interface TrackerEntry {
  tracker_key: string;
  day: Day;
  value: TrackerValue;
}

export interface EntryComponentProps {
  def: TrackerDef;
  /** Today's value, if already logged (editing). */
  initial: TrackerValue | null;
  saving: boolean;
  /** Placeholder suggestion, e.g. the last value. */
  hint?: string;
  onSave: (value: TrackerValue) => void;
  onCancel?: () => void;
}

export interface SummaryComponentProps {
  def: TrackerDef;
  today: Day;
  /** Entries from the last ~90 days, oldest first. */
  entries: TrackerEntry[];
}

export interface TrackerDef {
  key: string;
  name: string;
  unit?: string;
  kind: TrackerKind;
  /** number trackers */
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  placeholder?: string;
  /** Turn what was typed into a value (or an error message). */
  parse(input: string): TrackerValue | string;
  /** null = ok, otherwise a message for the user. */
  validate(value: TrackerValue): string | null;
  /** Value for display, without the unit. */
  format(value: TrackerValue): string;
  chart?: 'line' | 'none';
  entryComponent?: ComponentType<EntryComponentProps>;
  summaryComponent?: ComponentType<SummaryComponentProps>;
}

export function num(value: TrackerValue | null | undefined): number | null {
  return value && 'v' in value && typeof value.v === 'number' ? value.v : null;
}

export function text(value: TrackerValue | null | undefined): string | null {
  return value && 'text' in value && typeof value.text === 'string' ? value.text : null;
}

type NumberOpts = {
  key: string;
  name: string;
  unit?: string;
  min: number;
  max: number;
  decimals: number;
  step?: number;
  placeholder?: string;
} & Partial<Pick<TrackerDef, 'chart' | 'entryComponent' | 'summaryComponent'>>;

export function numberTracker(o: NumberOpts): TrackerDef {
  const round = (n: number) => Number(n.toFixed(o.decimals));
  const def: TrackerDef = {
    ...o,
    kind: 'number',
    chart: o.chart ?? 'line',
    step: o.step ?? 10 ** -o.decimals,
    parse(input) {
      const s = input.trim().replace(',', '.');
      if (!s) return 'Enter a number';
      if (!/^\d*\.?\d*$/.test(s) || s === '.') return 'Numbers only';
      const value = { v: round(Number(s)) };
      return def.validate(value) ?? value;
    },
    validate(value) {
      const n = num(value);
      if (n === null || !Number.isFinite(n)) return 'Enter a number';
      if (n < o.min || n > o.max) return `Enter ${o.name.toLowerCase()} between ${o.min} and ${o.max}${o.unit ? ' ' + o.unit : ''}`;
      return null;
    },
    format(value) {
      const n = num(value);
      return n === null ? '—' : n.toFixed(o.decimals);
    },
  };
  return def;
}

type TextOpts = {
  key: string;
  name: string;
  maxLength?: number;
  placeholder?: string;
} & Partial<Pick<TrackerDef, 'entryComponent' | 'summaryComponent'>>;

export function textTracker(o: TextOpts): TrackerDef {
  const max = o.maxLength ?? 1000;
  const def: TrackerDef = {
    ...o,
    kind: 'text',
    chart: 'none',
    parse(input) {
      const value = { text: input.trim() };
      return def.validate(value) ?? value;
    },
    validate(value) {
      const t = text(value);
      if (!t) return 'Write something first';
      if (t.length > max) return `Keep it under ${max} characters`;
      return null;
    },
    format(value) {
      return text(value) ?? '';
    },
  };
  return def;
}

export const TRACKERS: TrackerDef[] = [
  numberTracker({
    key: 'weight',
    name: 'Weight',
    unit: 'lb',
    min: 50,
    max: 700,
    decimals: 1,
    placeholder: '0.0',
  }),
];

export function trackerByKey(key: string): TrackerDef | undefined {
  return TRACKERS.find((t) => t.key === key);
}
