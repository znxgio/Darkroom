/* Preset library. Values are tuned by eye against portraits, street and landscape test frames.
   TV Set is the owner's own recipe: do not change its values. */
'use strict';
(function () {
const DEFAULTS = {
  exposure: 0, curve: null, rgb: null, contrast: 1, saturation: 1, mix: [1, 1, 1], scale: 1, fade: 0,
  shadowTint: null, shadowAmount: 0, highlightTint: null, highlightAmount: 0,
  halation: 0, halTint: [1, 0.35, 0.12], halThreshold: 0.62, softness: 0, grain: 0, grainSize: 1, chroma: 0,
  vignette: 0, leak: null, leakStrength: 0, fisheye: 0, border: null
};

const COLLECTIONS = [
  { id: 'film', name: 'Film' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'retro', name: 'Retro camera' },
  { id: 'cine', name: 'Cinematic' },
  { id: 'bw', name: 'B&W' },
  { id: 'soft', name: 'Soft' }
];

const WHITE = [1, 1, 1];
const LIST = [
  /* ---------- Film ---------- */
  { id: 'tvset', c: 'film', name: 'TV Set', saturation: .78, mix: [1.06, 1.02, .88], scale: .82, fade: 22 / 255,
    softness: .7, grain: .55, grainSize: 3, vignette: .6, leak: 'tr', leakStrength: .35,
    fisheye: .45, border: [235, 228, 210] },
  { id: 'golden', c: 'film', name: 'Golden 400', curve: [[0, .04], [.25, .24], [.5, .52], [.75, .78], [1, .96]],
    contrast: .95, saturation: .92, mix: [1.04, 1, .92], shadowTint: [.35, .5, .45], shadowAmount: .18,
    highlightTint: [1, .82, .6], highlightAmount: .2, halation: .15, grain: .25, grainSize: 1.4, vignette: .25 },
  { id: 'portrait160', c: 'film', name: 'Portrait 160', curve: [[0, .035], [.25, .26], [.5, .53], [.75, .785], [1, .965]],
    contrast: .9, saturation: .8, mix: [1.03, 1, .95], shadowTint: [.42, .5, .56], shadowAmount: .14,
    highlightTint: [1, .88, .76], highlightAmount: .16, halation: .08, grain: .2, grainSize: 1.2, vignette: .15 },
  { id: 'gold200', c: 'film', name: 'Gold 200', curve: [[0, .02], [.25, .22], [.5, .52], [.75, .8], [1, .97]],
    contrast: 1.05, saturation: 1.06, mix: [1.06, 1.02, .85], shadowTint: [.55, .45, .3], shadowAmount: .16,
    highlightTint: [1, .85, .5], highlightAmount: .25, halation: .12, grain: .3, grainSize: 1.5, vignette: .3 },
  { id: 'green400', c: 'film', name: 'Green 400', curve: [[0, .03], [.25, .23], [.5, .51], [.75, .79], [1, .97]],
    rgb: { g: [[0, .03], [.5, .51], [1, 1]] }, contrast: 1.02, saturation: .92, mix: [.96, 1.03, .99],
    shadowTint: [.28, .55, .5], shadowAmount: .3, highlightTint: [.95, 1, .9], highlightAmount: .1,
    grain: .35, grainSize: 1.5, vignette: .2 },
  { id: 'vivid100', c: 'film', name: 'Vivid 100', curve: [[0, 0], [.25, .21], [.5, .5], [.75, .8], [1, 1]],
    contrast: 1.12, saturation: 1.28, mix: [1.03, 1, .97], highlightTint: [1, .92, .8], highlightAmount: .1,
    grain: .12, grainSize: 1, vignette: .2 },
  { id: 'slide50', c: 'film', name: 'Slide 50', curve: [[0, 0], [.2, .13], [.5, .49], [.8, .87], [1, 1]],
    rgb: { b: [[0, .04], [.5, .52], [1, .97]] }, contrast: 1.16, saturation: 1.3, mix: [1, 1, 1.01],
    shadowTint: [.3, .35, .62], shadowAmount: .2, grain: .1, grainSize: 1, vignette: .3 },
  { id: 'cool400', c: 'film', name: 'Cool 400', curve: [[0, .03], [.25, .23], [.5, .51], [.75, .78], [1, .96]],
    contrast: 1, saturation: .84, mix: [.95, 1, 1.06], shadowTint: [.3, .45, .62], shadowAmount: .25,
    highlightTint: [.9, .95, 1], highlightAmount: .1, grain: .35, grainSize: 1.5, vignette: .25 },
  { id: 'coastfog', c: 'film', name: 'Coast Fog', exposure: .1, curve: [[0, .08], [.25, .28], [.5, .52], [.75, .74], [1, .92]],
    contrast: .85, saturation: .6, mix: [.96, 1, 1.04], scale: .9, fade: .07, shadowTint: [.45, .55, .6],
    shadowAmount: .2, softness: .4, grain: .3, grainSize: 1.6, vignette: .2 },

  /* ---------- Vintage ---------- */
  { id: 'expired', c: 'vintage', name: 'Expired', saturation: .85, mix: [1.08, .97, .94], scale: .9, fade: .06,
    highlightTint: [1, .7, .75], highlightAmount: .18, halation: .2, grain: .45, grainSize: 2.2,
    vignette: .4, leak: 'bl', leakStrength: .45 },
  { id: 'faded70', c: 'vintage', name: 'Faded ’70s', curve: [[0, .11], [.3, .32], [.6, .62], [1, .9]],
    rgb: { b: [[0, .14], [1, .84]] }, contrast: .88, saturation: .74, mix: [1.07, 1.02, .9],
    grain: .4, grainSize: 2, vignette: .35 },
  { id: 'chrome64', c: 'vintage', name: 'Chrome 64', curve: [[0, .01], [.25, .19], [.5, .49], [.75, .8], [1, .97]],
    rgb: { r: [[0, 0], [.5, .53], [1, 1]], b: [[0, .03], [.5, .48], [1, .95]] }, contrast: 1.14, saturation: 1.12,
    mix: [1.04, .99, .93], shadowTint: [.3, .38, .5], shadowAmount: .15, grain: .25, grainSize: 1.3, vignette: .3 },
  { id: 'summer79', c: 'vintage', name: 'Summer ’79', exposure: .15, curve: [[0, .07], [.3, .34], [.7, .74], [1, .95]],
    rgb: { r: [[0, .05], [1, 1]], b: [[0, .06], [1, .82]] }, contrast: .9, saturation: .72, mix: [1.05, 1.01, .92],
    shadowTint: [.3, .55, .55], shadowAmount: .2, halation: .2, grain: .35, grainSize: 1.8, vignette: .2,
    leak: 'tr', leakStrength: .22 },
  { id: 'mall86', c: 'vintage', name: 'Mall ’86', curve: [[0, .05], [.5, .52], [1, .95]], contrast: .95,
    saturation: .9, mix: [1.05, .95, 1.02], fade: .03, shadowTint: [.45, .4, .62], shadowAmount: .22,
    highlightTint: [1, .75, .85], highlightAmount: .25, grain: .4, grainSize: 1.8, vignette: .3 },
  { id: 'album', c: 'vintage', name: 'Album', curve: [[0, .08], [.5, .5], [1, .9]], rgb: { b: [[0, .05], [1, .8]] },
    contrast: .9, saturation: .58, mix: [1.05, 1, .84], fade: .05, highlightTint: [1, .9, .7], highlightAmount: .18,
    softness: .35, grain: .3, grainSize: 2, vignette: .5 },
  { id: 'cross', c: 'vintage', name: 'Cross', curve: [[0, .02], [.5, .5], [1, .98]],
    rgb: { r: [[0, 0], [.25, .17], [.75, .85], [1, 1]], g: [[0, .02], [.25, .22], [.75, .82], [1, 1]], b: [[0, .2], [1, .78]] },
    contrast: 1.08, saturation: 1.12, grain: .3, grainSize: 1.4, vignette: .35 },
  { id: 'bypass', c: 'vintage', name: 'Bypass', curve: [[0, 0], [.25, .18], [.5, .5], [.75, .84], [1, 1]],
    contrast: 1.25, saturation: .45, mix: [1, 1.01, 1.03], grain: .35, grainSize: 1.3, vignette: .4 },

  /* ---------- Retro camera ---------- */
  { id: 'disposable', c: 'retro', name: 'Disposable', curve: [[0, .02], [.25, .2], [.5, .51], [.75, .82], [1, .98]],
    contrast: 1.12, saturation: 1.1, mix: [1.06, 1, .88], softness: .35, halation: .12, grain: .5, grainSize: 2,
    chroma: .08, vignette: .7 },
  { id: 'instant', c: 'retro', name: 'Instant', curve: [[0, .07], [.5, .52], [1, .93]],
    rgb: { r: [[0, .05], [1, .98]], b: [[0, .13], [1, .9]] }, contrast: .88, saturation: .8, mix: [1.03, 1.02, .96],
    highlightTint: [1, .95, .8], highlightAmount: .15, softness: .45, grain: .2, grainSize: 1.4, vignette: .35 },
  { id: 'instantcool', c: 'retro', name: 'Instant Cool', curve: [[0, .08], [.5, .53], [1, .94]], contrast: .9,
    saturation: .7, mix: [.94, 1.01, 1.04], fade: .03, shadowTint: [.3, .55, .62], shadowAmount: .3,
    softness: .4, grain: .2, grainSize: 1.4, vignette: .3 },
  { id: 'digicam', c: 'retro', name: 'Digicam ’04', exposure: .12, curve: [[0, 0], [.5, .55], [.85, .99], [1, 1]],
    contrast: 1.1, saturation: 1.15, mix: [.97, 1, 1.05], halation: .15, halTint: WHITE, halThreshold: .7,
    chroma: .25, grain: .08, grainSize: 1 },
  { id: 'ccd', c: 'retro', name: 'CCD', exposure: .08, curve: [[0, .02], [.5, .53], [.9, .98], [1, 1]],
    contrast: 1.05, saturation: 1.05, mix: [1.02, .97, 1.06], halation: .45, halTint: [1, .95, .95], halThreshold: .55,
    shadowTint: [.4, .4, .6], shadowAmount: .2, chroma: .2, vignette: .1 },
  { id: 'flash35', c: 'retro', name: 'Flash 35', curve: [[0, 0], [.2, .12], [.5, .5], [.8, .88], [1, 1]],
    contrast: 1.15, saturation: 1.04, mix: [1.05, 1, .92], halation: .2, grain: .45, grainSize: 1.8, vignette: .55 },
  { id: 'super8', c: 'retro', name: 'Super 8', curve: [[0, .06], [.5, .5], [1, .93]], contrast: 1.05,
    saturation: .9, mix: [1.08, 1, .84], fade: .02, softness: .6, halation: .25, grain: .7, grainSize: 2.6,
    vignette: .6, leak: 'bl', leakStrength: .2 },
  { id: 'camcorder', c: 'retro', name: 'Camcorder', curve: [[0, .04], [.5, .52], [1, .96]], contrast: 1.1,
    saturation: 1.2, mix: [1.04, 1, 1.02], fade: .04, softness: .5, chroma: .3, grain: .2, grainSize: 1, vignette: .15 },

  /* ---------- Cinematic ---------- */
  { id: 'sodium', c: 'cine', name: 'Sodium', curve: [[0, .02], [.25, .2], [.5, .5], [.75, .8], [1, .97]],
    contrast: 1.08, saturation: .85, mix: [1.03, .98, .95], shadowTint: [.1, .45, .5], shadowAmount: .35,
    highlightTint: [1, .6, .25], highlightAmount: .3, halation: .45, grain: .3, grainSize: 1.2, vignette: .45 },
  { id: 'observer', c: 'cine', name: 'Observer', contrast: .92, saturation: .7, mix: [.98, 1, 1.03], scale: .94, fade: .05,
    shadowTint: [.3, .4, .5], shadowAmount: .22, highlightTint: [.95, .9, .8], highlightAmount: .12,
    halation: .1, softness: .3, grain: .4, grainSize: 2, vignette: .65 },
  { id: 'blockbuster', c: 'cine', name: 'Blockbuster', curve: [[0, .02], [.25, .21], [.5, .5], [.75, .8], [1, .98]],
    contrast: 1.12, saturation: .95, shadowTint: [.12, .5, .56], shadowAmount: .45,
    highlightTint: [1, .65, .35], highlightAmount: .35, grain: .15, grainSize: 1.2, vignette: .35 },
  { id: 'neon', c: 'cine', name: 'Neon Night', curve: [[0, 0], [.25, .17], [.5, .48], [.75, .8], [1, 1]],
    contrast: 1.1, saturation: 1.12, mix: [1, .97, 1.04], shadowTint: [.2, .3, .62], shadowAmount: .35,
    highlightTint: [1, .55, .75], highlightAmount: .2, halation: .5, halThreshold: .55, grain: .3, grainSize: 1.4, vignette: .4 },
  { id: 'cine800t', c: 'cine', name: '800T', curve: [[0, .04], [.25, .23], [.5, .51], [.75, .79], [1, .97]],
    contrast: 1.02, saturation: .9, mix: [.9, .98, 1.1], shadowTint: [.2, .45, .55], shadowAmount: .25,
    halation: .55, halThreshold: .58, grain: .4, grainSize: 1.6, vignette: .3 },
  { id: 'overcast', c: 'cine', name: 'Overcast', exposure: -.15, curve: [[0, .04], [.5, .5], [1, .95]], contrast: 1.05,
    saturation: .6, fade: .03, shadowTint: [.3, .45, .45], shadowAmount: .35, highlightTint: [.9, .88, .85],
    highlightAmount: .1, grain: .3, grainSize: 1.5, vignette: .5 },
  { id: 'dune', c: 'cine', name: 'Dune', curve: [[0, .03], [.5, .51], [1, .96]], contrast: 1.05, saturation: .8,
    mix: [1.08, 1, .85], fade: .03, shadowTint: [.5, .35, .25], shadowAmount: .2, highlightTint: [1, .8, .55],
    highlightAmount: .3, halation: .1, grain: .25, grainSize: 1.4, vignette: .3 },
  { id: 'glasshouse', c: 'cine', name: 'Glasshouse', curve: [[0, .02], [.25, .19], [.5, .5], [.75, .81], [1, .97]],
    contrast: 1.15, saturation: .7, mix: [.94, 1.04, .94], shadowTint: [.25, .5, .35], shadowAmount: .35,
    grain: .25, grainSize: 1.3, vignette: .45 },

  /* ---------- B&W ---------- */
  { id: 'silver', c: 'bw', name: 'Silver 400', curve: [[0, .02], [.25, .2], [.5, .5], [.75, .8], [1, .98]],
    contrast: 1.15, saturation: 0, grain: .6, grainSize: 1.8, vignette: .35 },
  { id: 'push1600', c: 'bw', name: 'Push 1600', curve: [[0, 0], [.25, .14], [.5, .5], [.8, .9], [1, 1]],
    rgb: { b: [[0, 0], [1, .85]] }, contrast: 1.3, saturation: 0, grain: .85, grainSize: 2.4, vignette: .45 },
  { id: 'pearl', c: 'bw', name: 'Pearl', curve: [[0, .06], [.5, .53], [1, .96]], contrast: .85, saturation: 0,
    fade: .03, highlightTint: [1, .95, .88], highlightAmount: .15, softness: .3, grain: .25, grainSize: 1.4, vignette: .25 },
  { id: 'selenium', c: 'bw', name: 'Selenium', curve: [[0, .01], [.25, .19], [.5, .5], [.75, .81], [1, .98]],
    contrast: 1.1, saturation: 0, shadowTint: [.4, .38, .58], shadowAmount: .5, grain: .35, grainSize: 1.6, vignette: .35 },
  { id: 'sepia', c: 'bw', name: 'Sepia', curve: [[0, .04], [.5, .5], [1, .95]], contrast: 1.02, saturation: 0,
    shadowTint: [.55, .4, .25], shadowAmount: .5, highlightTint: [1, .9, .7], highlightAmount: .4, fade: .03,
    grain: .35, grainSize: 2, vignette: .4 },
  { id: 'noir', c: 'bw', name: 'Noir', curve: [[0, 0], [.3, .15], [.6, .62], [1, 1]], rgb: { b: [[0, 0], [1, .7]] },
    contrast: 1.4, saturation: 0, grain: .4, grainSize: 1.5, vignette: .6 },
  { id: 'ghost', c: 'bw', name: 'Ghost', rgb: { g: [[0, 0], [.5, .82], [1, 1]], b: [[0, 0], [1, .5]] },
    contrast: 1.2, saturation: 0, halation: .4, halTint: WHITE, halThreshold: .55, grain: .3, grainSize: 1.5, vignette: .3 },

  /* ---------- Soft ---------- */
  { id: 'pastel', c: 'soft', name: 'Pastel', exposure: .2, curve: [[0, .08], [.5, .55], [1, .97]], contrast: .8,
    saturation: .7, fade: .04, shadowTint: [.55, .55, .65], shadowAmount: .2, highlightTint: [1, .9, .92],
    highlightAmount: .2, softness: .2 },
  { id: 'dreamy', c: 'soft', name: 'Dreamy', exposure: .15, curve: [[0, .05], [.5, .54], [1, .97]], contrast: .9,
    saturation: .85, fade: .03, highlightTint: [1, .85, .85], highlightAmount: .2, halation: .5, halTint: [1, .92, .9],
    halThreshold: .45, softness: .5 },
  { id: 'haze', c: 'soft', name: 'Haze', curve: [[0, .1], [.5, .55], [1, .95]], contrast: .9, saturation: .7,
    mix: [1.02, 1, 1.02], fade: .04, halation: .3, halTint: WHITE, halThreshold: .5, grain: .15, grainSize: 1.2 },
  { id: 'milk', c: 'soft', name: 'Milk', exposure: .25, curve: [[0, .1], [.5, .56], [1, .96]], contrast: .85,
    saturation: .6, mix: [1.02, 1.01, .96], fade: .04, softness: .2 },
  { id: 'peach', c: 'soft', name: 'Peach', exposure: .1, curve: [[0, .05], [.5, .53], [1, .97]], saturation: .85,
    mix: [1.06, .98, .95], fade: .03, shadowTint: [.6, .45, .45], shadowAmount: .15, highlightTint: [1, .8, .7],
    highlightAmount: .3, softness: .2, grain: .12, grainSize: 1.2 },
  { id: 'lavender', c: 'soft', name: 'Lavender', exposure: .1, curve: [[0, .06], [.5, .53], [1, .96]], saturation: .75,
    mix: [1, .96, 1.06], fade: .04, shadowTint: [.5, .45, .65], shadowAmount: .3, highlightTint: [.95, .9, 1],
    highlightAmount: .2, softness: .2 },
  { id: 'cotton', c: 'soft', name: 'Cotton', exposure: .12, curve: [[0, .06], [.5, .53], [1, .96]], contrast: .82,
    saturation: .8, fade: .05, softness: .7, grain: .15, grainSize: 1, vignette: .1 }
];

const PRESETS = LIST.map(p => ({ ...DEFAULTS, ...p }));
const BY_ID = {};
for (const p of PRESETS) BY_ID[p.id] = p;

window.DRPresets = { DEFAULTS, COLLECTIONS, PRESETS, BY_ID, get: id => BY_ID[id] || PRESETS[0] };
})();
