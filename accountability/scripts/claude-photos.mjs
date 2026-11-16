// For a Claude session: download the owner's dated photos to a local folder so they can be viewed.
// Needs: PHOTO_ACCESS_URL (https://<project>.supabase.co/functions/v1/photo-access)
// and the key, either in env PHOTO_ACCESS_KEY or injected by the session's credential proxy
// as the x-photo-key header. Also needs the owner's "Let Claude view my photos" switch ON.
//
//   node scripts/claude-photos.mjs --latest 7 --out /path/to/scratch/photos
//   node scripts/claude-photos.mjs --from 2026-11-01 --to 2026-11-30 --out ...
// Files: <out>/<YYYY-MM-DD>_day<N>_face.jpg, ..._body.jpg, plus index.json. Never commit them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const base = process.env.PHOTO_ACCESS_URL;
if (!base || !args.out) {
  console.error('Usage: PHOTO_ACCESS_URL=... node scripts/claude-photos.mjs (--latest N | --from D --to D) --out DIR');
  process.exit(2);
}
const qs = args.from ? `from=${args.from}&to=${args.to}` : `latest=${args.latest ?? 7}`;
const headers = process.env.PHOTO_ACCESS_KEY ? { 'x-photo-key': process.env.PHOTO_ACCESS_KEY } : { 'x-photo-key': 'injected-by-proxy' };
const res = await fetch(`${base}?${qs}`, { headers });
const body = await res.json();
if (!res.ok) {
  console.error(`Error ${res.status}:`, body.error ?? body);
  process.exit(1);
}
mkdirSync(args.out, { recursive: true });
const index = [];
for (const d of body.days) {
  const entry = { day: d.day, day_number: d.day_number, weight_lbs: d.weight_lbs, files: {} };
  for (const kind of ['face', 'body']) {
    if (!d[kind]) continue;
    const r = await fetch(d[kind]);
    if (!r.ok) continue;
    const file = join(args.out, `${d.day}_day${d.day_number}_${kind}.jpg`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    entry.files[kind] = file;
  }
  index.push(entry);
}
writeFileSync(join(args.out, 'index.json'), JSON.stringify(index, null, 2));
for (const e of index) console.log(`${e.day} (day ${e.day_number})${e.weight_lbs ? ` ${e.weight_lbs} lb` : ''}: ${Object.values(e.files).join('  ')}`);
console.log(`\n${index.length} day(s) saved to ${args.out}`);
