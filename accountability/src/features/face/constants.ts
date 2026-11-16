// Shared constants for the face feature (kept tiny: imported by the main bundle).

/** Must match the installed @mediapipe/tasks-vision (a unit test checks). */
export const MP_VERSION = '0.10.21';
/** Wasm files are copied here from node_modules at build time (scripts/copy-mediapipe.mjs). */
export const WASM_BASE = `/mediapipe/wasm-${MP_VERSION}`;
/** Model file, committed under public/ (float16 face landmarker, v1). */
export const MODEL_URL = '/mediapipe/face_landmarker-f16-v1.task';
/** Bump when the metric math or ranges change: cached results are recomputed. */
export const CACHE_VERSION = 1;
export const FACE_TRACKER = 'face_score';
