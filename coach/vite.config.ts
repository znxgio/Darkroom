import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The on-device detector's engine (WebAssembly) is served from our own site.
// Copied from the npm package so it always matches the installed version (not committed to git).
function mediapipeWasm(): Plugin {
  const copy = () => {
    const from = resolve(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/wasm');
    const to = resolve(import.meta.dirname, 'public/mediapipe');
    mkdirSync(to, { recursive: true });
    for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) copyFileSync(resolve(from, f), resolve(to, f));
  };
  return { name: 'mediapipe-wasm', buildStart: copy, configureServer: copy };
}

export default defineConfig({
  plugins: [react(), mediapipeWasm()],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
