// Copies the face-landmark wasm files from node_modules into public/ so they're self-hosted
// (served from our own domain, never a CDN). Runs before `dev` and `build`. The copies are
// git-ignored; the model file (public/mediapipe/*.task) is committed.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules/@mediapipe/tasks-vision');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const pub = join(root, 'public/mediapipe');
const dest = join(pub, `wasm-${version}`);
mkdirSync(dest, { recursive: true });

// Remove copies from older versions.
for (const d of readdirSync(pub)) if (d.startsWith('wasm-') && d !== `wasm-${version}`) rmSync(join(pub, d), { recursive: true });

let copied = 0;
for (const f of readdirSync(join(pkgDir, 'wasm'))) {
  const from = join(pkgDir, 'wasm', f);
  const to = join(dest, f);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`mediapipe wasm ${version}: ${copied ? `copied ${copied} file(s)` : 'up to date'}`);
