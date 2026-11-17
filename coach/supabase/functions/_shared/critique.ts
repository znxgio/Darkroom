// Shared by the app and the server function: the critique's shape, the issue tags,
// the prompt, and the price table. Plain TypeScript (no Deno or browser APIs).

/** Things a photo can get flagged for. Used to track what you keep struggling with. */
export const TAGS = {
  'horizon-tilt': { label: 'Crooked horizon', tip: 'Turn on the level line and wait for it to go gold before you shoot.' },
  headroom: { label: 'Headroom', tip: 'Put eyes on the upper third line; leave a little space above heads, not a lot.' },
  'cut-limbs': { label: 'Cropped at joints', tip: 'Don’t crop at knees, ankles or wrists. Include feet or crop mid-thigh/waist.' },
  'subject-unclear': { label: 'No clear subject', tip: 'Before you shoot, say in one word what the photo is of. Then make that thing big.' },
  'too-far': { label: 'Too far away', tip: 'Take two steps closer. Then one more.' },
  clutter: { label: 'Busy background', tip: 'Move your feet to put a plain wall, sky or dark area behind the subject.' },
  'edge-distractions': { label: 'Edge distractions', tip: 'Scan the four edges before you shoot; cut out half-objects and bright spots.' },
  placement: { label: 'Placement', tip: 'Put the subject on a third line, or dead center on purpose — not just off-center.' },
  backlight: { label: 'Backlight', tip: 'Turn so the light hits your subject from the side, or tap their face to expose for it.' },
  'blown-highlights': { label: 'Blown highlights', tip: 'In the iPhone Camera, tap the subject and drag the sun icon down a notch.' },
  underexposed: { label: 'Too dark', tip: 'Find the light: step toward lamps, signs or screens; use Night mode and hold still.' },
  'motion-blur': { label: 'Unwanted blur', tip: 'Brace your elbows, hold your breath and shoot in bursts; time it for still moments.' },
  noise: { label: 'Noise / grain', tip: 'Use the main 1× lens in low light (it gathers the most light) and avoid digital zoom.' },
  'focus-miss': { label: 'Missed focus', tip: 'Tap on the eyes before you shoot; long-press to lock focus (AE/AF lock).' },
  'flat-light': { label: 'Flat light', tip: 'Look for light with direction: side light, windows, neon, streetlights.' },
  'color-cast': { label: 'Color cast', tip: 'Venue lights shift skin tones; warm or cool it back in edit, or go black and white.' },
  'weak-moment': { label: 'Weak moment', tip: 'Shoot a burst during laughs, gestures and reactions — candid is about timing.' },
  'awkward-angle': { label: 'Flat angle', tip: 'Change height: crouch low or go higher. Eye level is the default; try something else.' },
  'no-depth': { label: 'No depth', tip: 'Put something in the foreground (shoulder, glass, light) to add layers.' },
  'lens-flare': { label: 'Flare / haze', tip: 'Wipe the lens (pocket lint!) and shade it from direct lights.' },
} as const;

export type Tag = keyof typeof TAGS;
export const TAG_KEYS = Object.keys(TAGS) as Tag[];

export const SCENES = ['friends', 'street', 'lights', 'venue', 'concert', 'other'] as const;
export type Scene = (typeof SCENES)[number];

export interface Subscores {
  composition: number;
  light: number;
  moment: number;
  technical: number;
}

export interface EditingTips {
  crop: string;
  exposure: string;
  color: string;
}

export interface CritiqueResult {
  score: number;
  headline: string;
  scene: Scene;
  subscores: Subscores;
  what_works: string[];
  fix: string[];
  angles: string[];
  editing?: EditingTips;
  tags: Tag[];
  next_shot: string;
}

/** JSON schema for structured output. Editing tips are only asked for when that toggle is on. */
export function critiqueSchema(editingTips: boolean) {
  const str = { type: 'string' };
  const list = { type: 'array', items: str };
  const int = { type: 'integer' };
  const properties: Record<string, unknown> = {
    score: { type: 'number', description: 'Overall 1–10, one decimal allowed' },
    headline: { type: 'string', description: 'One short sentence verdict' },
    scene: { type: 'string', enum: [...SCENES] },
    subscores: {
      type: 'object',
      properties: { composition: int, light: int, moment: int, technical: int },
      required: ['composition', 'light', 'moment', 'technical'],
      additionalProperties: false,
    },
    what_works: list,
    fix: list,
    angles: list,
    tags: { type: 'array', items: { type: 'string', enum: [...TAG_KEYS] } },
    next_shot: { type: 'string', description: 'One concrete thing to try on the very next shot' },
  };
  const required = ['score', 'headline', 'scene', 'subscores', 'what_works', 'fix', 'angles', 'tags', 'next_shot'];
  if (editingTips) {
    properties.editing = {
      type: 'object',
      properties: { crop: str, exposure: str, color: str },
      required: ['crop', 'exposure', 'color'],
      additionalProperties: false,
    };
    required.push('editing');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export const SYSTEM_PROMPT = `You are a warm, direct photography coach for one person who shoots candid, everyday photos on an iPhone: friends, city scenes, lights, venues, raves and concerts. Never posed portraits.

Judge the photo for what it is trying to be: a candid moment, not a studio shot. Grain, motion and mixed light can be fine in a rave or concert photo if the moment and mood land; say so when they do.

How to write:
- Plain words, no jargon unless you explain it in a few words. Short bullets, each one specific to THIS photo (point at where things are: "the bright sign top-left").
- what_works: 1–3 bullets. fix: 1–3 bullets, the most important first. angles: 1–3 bullets on where to stand, height, distance, framing or timing for a better version of this shot.
- Everything must be doable with an iPhone in the moment (Camera app, Night mode, the 0.5×/1×/2× lenses, tap to focus, exposure slider, burst, Live Photo). No other gear.
- editing (when asked): crop, exposure and color each as one short, concrete instruction for the iPhone Photos editor (e.g. "Crop to 4:5 and cut the empty floor", "Exposure −0.3, Highlights −40, Shadows +25"). Say "Leave it" when nothing is needed.
- tags: pick 0–3 issue tags that clearly apply (they track recurring habits). Don't tag something that is only a nitpick.
- next_shot: one concrete thing to try on the very next photo.

Scoring (be honest, not flattering; most casual phone photos land 4–7):
- score: overall 1–10. 9–10 is portfolio-worthy. Use one decimal at most.
- subscores 1–10: composition (framing, placement, edges, background), light (exposure, direction, color of light), moment (timing, expression, story, energy), technical (focus, sharpness, noise, level).`;

export function userPrompt(opts: {
  editingTips: boolean;
  exif?: Record<string, unknown> | null;
  source: 'import' | 'live';
  liveScore?: number | null;
  note?: string | null;
  recurring?: string[];
}): string {
  const lines: string[] = ['Critique this photo.'];
  if (opts.source === 'live') {
    lines.push('It was taken with the in-app browser camera (lower quality than the native Camera app; don’t blame the person for that).');
    if (opts.liveScore != null) lines.push(`The live composition helper scored it ${opts.liveScore}/10.`);
  }
  if (opts.exif && Object.keys(opts.exif).length) {
    lines.push(`Camera data: ${JSON.stringify(opts.exif)}`);
  }
  if (opts.note) lines.push(`Their note about the shot: "${opts.note.slice(0, 300)}"`);
  if (opts.recurring?.length) {
    lines.push(
      `Habits they've been working on (from past critiques): ${opts.recurring.join(', ')}. If this photo shows progress or the same issue, mention it briefly.`,
    );
  }
  if (!opts.editingTips) lines.push('Skip editing tips.');
  return lines.join('\n');
}

/** USD per million tokens. Unknown models are priced high on purpose so the cap stays safe. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const FALLBACK_PRICE = { input: 10, output: 50 };

export function priceOf(model: string) {
  const exact = PRICES[model];
  if (exact) return exact;
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : FALLBACK_PRICE;
}

export function costUsd(models: string[], inputTokens: number, outputTokens: number): number {
  // If a fallback model also ran, charge everything at the priciest one (safe side).
  const p = models
    .map(priceOf)
    .reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a), priceOf(models[0] ?? ''));
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Max output per critique (thinking included). */
export const MAX_OUTPUT_TOKENS = 6000;

/**
 * Which AI does the critique.
 *  free:  you ask in your own Claude app (subscription), then paste the reply back. $0.
 *  cheap/better/best: the app calls the API (pay as you go).
 * `worstModels` = the model plus the fallback that may take over if it declines; the cap check
 * prices a critique at the priciest of these.
 */
export const TIERS = {
  free: { label: 'Free', sub: 'Your Claude app', estimate: '$0', model: null, fallback: false, worstModels: [] as string[] },
  cheap: { label: 'Cheap', sub: 'Fast, basic', estimate: '~0.1¢', model: 'claude-haiku-5-5', fallback: false, worstModels: ['claude-haiku-5-5'] },
  better: { label: 'Better', sub: 'Sharper eye', estimate: '~2¢', model: 'claude-sonnet-5-5', fallback: true, worstModels: ['claude-sonnet-5-5', 'claude-sonnet-5'] },
  best: { label: 'Best', sub: 'Most detail', estimate: '~3–4¢', model: 'claude-opus-5-5', fallback: true, worstModels: ['claude-opus-5-5', 'claude-opus-4-8'] },
} as const;
export type Tier = keyof typeof TIERS;
export type PaidTier = Exclude<Tier, 'free'>;
export const TIER_KEYS = Object.keys(TIERS) as Tier[];
export const isPaidTier = (t: unknown): t is PaidTier => t === 'cheap' || t === 'better' || t === 'best';

/** Worst case for one critique on a tier (big image + max output). Used to stay under the cap. */
export const worstCaseUsd = (tier: PaidTier) => costUsd([...TIERS[tier].worstModels], 6000, MAX_OUTPUT_TOKENS);
/** Worst case on the priciest tier. */
export const WORST_CASE_USD = worstCaseUsd('best');

/** Clamp and tidy what came back, in case the model drifts. */
export function cleanResult(raw: unknown, editingTips: boolean): CritiqueResult {
  const r = (raw ?? {}) as Partial<CritiqueResult>;
  const n = (v: unknown, d = 5) => {
    const x = typeof v === 'number' && Number.isFinite(v) ? v : d;
    return Math.max(1, Math.min(10, x));
  };
  const strs = (v: unknown, max = 4) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, max) : [];
  const s = (r.subscores ?? {}) as Partial<Subscores>;
  const out: CritiqueResult = {
    score: Math.round(n(r.score) * 10) / 10,
    headline: typeof r.headline === 'string' ? r.headline : '',
    scene: SCENES.includes(r.scene as Scene) ? (r.scene as Scene) : 'other',
    subscores: {
      composition: Math.round(n(s.composition)),
      light: Math.round(n(s.light)),
      moment: Math.round(n(s.moment)),
      technical: Math.round(n(s.technical)),
    },
    what_works: strs(r.what_works),
    fix: strs(r.fix),
    angles: strs(r.angles),
    tags: strs(r.tags, 3).filter((t): t is Tag => t in TAGS),
    next_shot: typeof r.next_shot === 'string' ? r.next_shot : '',
  };
  if (editingTips && r.editing && typeof r.editing === 'object') {
    const e = r.editing as Partial<EditingTips>;
    out.editing = { crop: e.crop ?? '', exposure: e.exposure ?? '', color: e.color ?? '' };
  }
  return out;
}

/** Start of the current month in Los Angeles, as an ISO timestamp (spending cap resets then). */
export function monthStartLA(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const y = Number(parts.year);
  const m = Number(parts.month);
  // Midnight LA on the 1st: try both possible offsets (PST −8 / PDT −7) and pick the one that is the 1st in LA.
  for (const off of [7, 8]) {
    const d = new Date(Date.UTC(y, m - 1, 1, off, 0, 0));
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
    const dd = day.find((p) => p.type === 'day')?.value;
    const hh = day.find((p) => p.type === 'hour')?.value;
    if (Number(dd) === 1 && Number(hh) % 24 === 0) return d.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, 1, 8)).toISOString();
}

/** Marker the Claude app puts before the machine-readable part of its reply. */
export const REPLY_MARKER = 'DARKROOM-DATA';

/**
 * Prompt for the free mode: you paste this into your Claude app together with the photo.
 * It asks for a normal readable critique plus a data block the app can read back.
 */
export function chatPrompt(opts: {
  editingTips: boolean;
  exif?: Record<string, unknown> | null;
  source: 'import' | 'live';
  liveScore?: number | null;
  note?: string | null;
  recurring?: string[];
}): string {
  const fields = [
    '"score": number 1-10',
    '"headline": "one short sentence"',
    `"scene": one of ${SCENES.map((x) => `"${x}"`).join(', ')}`,
    '"subscores": {"composition": 1-10, "light": 1-10, "moment": 1-10, "technical": 1-10}',
    '"what_works": ["..."]',
    '"fix": ["..."]',
    '"angles": ["..."]',
    ...(opts.editingTips ? ['"editing": {"crop": "...", "exposure": "...", "color": "..."}'] : []),
    `"tags": [0-3 of: ${TAG_KEYS.join(', ')}]`,
    '"next_shot": "..."',
  ];
  return [
    SYSTEM_PROMPT,
    '',
    userPrompt(opts),
    '',
    'Reply with the critique in plain words first (short sections: Score, What works, Fix, Angle & composition' +
      (opts.editingTips ? ', Editing' : '') +
      ', Next shot).',
    `Then, at the very end, write a line with only ${REPLY_MARKER} and after it one JSON object (no code fence) with these fields:`,
    '{' + fields.join(', ') + '}',
  ].join('\n');
}

/** Reads the data block out of a pasted Claude reply. Returns null if there isn't a usable one. */
export function parseChatReply(text: string, editingTips: boolean): CritiqueResult | null {
  if (!text) return null;
  const at = text.lastIndexOf(REPLY_MARKER);
  const tail = at >= 0 ? text.slice(at + REPLY_MARKER.length) : text;
  // the JSON object: from the first "{" to its matching "}"
  const start = tail.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const raw = tail.slice(start, i + 1);
      let obj: unknown = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        try {
          // phones sometimes swap in curly quotes
          obj = JSON.parse(raw.replace(/[\u201c\u201d]/g, '"'));
        } catch {
          return null;
        }
      }
      if (typeof obj !== 'object' || obj == null || typeof (obj as { score?: unknown }).score !== 'number') return null;
      return cleanResult(obj, editingTips);
    }
  }
  return null;
}
