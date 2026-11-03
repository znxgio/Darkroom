/* Preset library.
   Each look has a signature built from the research in FILTERS.md: per-colour HSL shifts (the big one),
   tinted blacks/highlights, and a contrast/fade shape. Grain, halation etc. are secondary.
   The owner's original eight (TV Set, Golden 400, Sodium, Coast Fog, Observer, Expired, Bypass, Silver 400)
   are kept exactly as they were. TV Set is the owner's own recipe: do not change its values.

   hsl: { band: [hue shift in degrees, saturation multiplier, luminance shift] }
        bands: red, orange (skin), yellow, green, aqua, blue, purple, magenta.
        Positive hue moves toward the next band (red→orange→yellow→green→aqua→blue→purple→magenta).
   lift: tinted black level added after the curve, [r, g, b]. */
'use strict';
(function () {
const DEFAULTS = {
  exposure: 0, curve: null, rgb: null, hsl: null, lift: null, contrast: 1, saturation: 1, mix: [1, 1, 1], scale: 1, fade: 0,
  shadowTint: null, shadowAmount: 0, highlightTint: null, highlightAmount: 0,
  halation: 0, halTint: [1, 0.35, 0.12], halThreshold: 0.62, softness: 0, grain: 0, grainSize: 1, chroma: 0,
  vignette: 0, leak: null, leakStrength: 0, fisheye: 0, border: null
};

const COLLECTIONS = [
  { id: 'popular', name: 'Popular', ids: ['latte', 'maple', 'lilac', 'analog', 'candy', 'rust', 'field', 'portrait400', 'gold200', 'tvset', 'reportage',
    'negative', 'cine800t', 'mattecool', 'goldenhour', 'mint400', 'silver', 'nostalgia', 'blush'] },
  { id: 'trends', name: 'Trends' },
  { id: 'autumn', name: 'Autumn' },
  { id: 'mood', name: 'Mood' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'everyday', name: 'Everyday' },
  { id: 'film', name: 'Film' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'retro', name: 'Retro camera' },
  { id: 'cine', name: 'Cinematic' },
  { id: 'bw', name: 'B&W' },
  { id: 'soft', name: 'Soft' }
];

const WHITE = [1, 1, 1];
const LIST = [
  /* ---------- Trends / Autumn / Mood / Minimal: subtle Esti-style colour looks, no built-in grain ---------- */
  { id: 'latte', c: 'trends', name: 'Latte', // creamy mid-brown, milky highlights
    exposure: -.04, curve: [[0, .06], [.5, .51], [1, .95]], saturation: .78, mix: [1.07, 1, .86], highlightTint: [1, .88, .72], highlightAmount: .35,
    shadowTint: [.48, .4, .32], shadowAmount: .25, hsl: { orange: [-4, 1.1, 0], green: [-24, .55, -.03], blue: [0, .55, 0] } },
  { id: 'toffee', c: 'trends', name: 'Toffee', // light golden caramel
    exposure: .06, curve: [[0, .04], [.5, .53], [1, .97]], contrast: 1.02, saturation: .95, mix: [1.08, 1.03, .82],
    highlightTint: [1, .82, .55], highlightAmount: .3, hsl: { orange: [-2, 1.2, 0], yellow: [-8, 1, 0], green: [-24, .6, -.03], blue: [0, .5, 0] } },
  { id: 'rosewood', c: 'trends', name: 'Rosewood', // dark romance: muted wine reds, cool dark shadows
    exposure: -.1, curve: [[0, .04], [.5, .47], [1, .93]], contrast: 1.06, saturation: .8, mix: [1.03, .95, .98],
    shadowTint: [.4, .32, .45], shadowAmount: .35, hsl: { red: [-8, 1.15, -.08], orange: [-6, .95, 0], green: [10, .55, -.06], blue: [10, .7, -.05] } },
  { id: 'honeybee', c: 'trends', name: 'Honey', // golden yellows, warm bright skin
    exposure: .08, curve: [[0, .04], [.5, .54], [1, .98]], saturation: 1, mix: [1.07, 1.04, .84], highlightTint: [1, .84, .5], highlightAmount: .3,
    hsl: { yellow: [-6, 1.2, .08], orange: [2, 1.05, .05], green: [-18, .85, .04] } },
  { id: 'cream', c: 'trends', name: 'Butter', // pale buttery yellow wash, airy
    exposure: .15, curve: [[0, .08], [.5, .56], [1, .97]], contrast: .9, saturation: .75, mix: [1.04, 1.04, .9],
    hsl: { yellow: [0, 1.1, .1], green: [-15, .7, .06], blue: [0, .6, .05] } },
  { id: 'morning', c: 'trends', name: 'Morning', // fresh soft daylight, gentle cool shadows
    exposure: .12, curve: [[0, .04], [.5, .55], [1, .99]], contrast: .95, saturation: .9, mix: [1, 1.01, 1.02],
    shadowTint: [.4, .5, .6], shadowAmount: .2, highlightTint: [1, .94, .86], highlightAmount: .15 },
  { id: 'espresso', c: 'trends', name: 'Espresso', // deep dark brown, low key
    exposure: -.2, curve: [[0, .05], [.5, .45], [1, .9]], contrast: 1.08, saturation: .75, mix: [1.08, .99, .82], lift: [.02, .01, 0],
    hsl: { orange: [-6, 1.2, -.08], green: [-30, .45, -.1], blue: [0, .4, -.05], yellow: [-12, .8, -.08] } },

  { id: 'maple', c: 'autumn', name: 'Maple', // red-orange leaves, warm amber light
    curve: [[0, .03], [.5, .51], [1, .96]], saturation: 1, mix: [1.08, 1, .86], highlightTint: [1, .78, .5], highlightAmount: .25,
    hsl: { yellow: [-14, 1.1, -.02], green: [-35, .7, -.04], orange: [-6, 1.2, 0], red: [0, 1.1, -.04] } },
  { id: 'hazel', c: 'autumn', name: 'Hazel', // muted olive-brown, earthy
    curve: [[0, .06], [.5, .5], [1, .93]], saturation: .72, mix: [1.04, 1.02, .86], shadowTint: [.45, .45, .32], shadowAmount: .3,
    hsl: { green: [-25, .7, -.04], yellow: [-10, .8, -.04], blue: [0, .5, 0], orange: [-4, 1.05, 0] } },
  { id: 'cider', c: 'autumn', name: 'Cider', // bright golden orange, glowing
    exposure: .06, curve: [[0, .03], [.5, .53], [1, .98]], saturation: 1.08, mix: [1.1, 1.02, .8], highlightTint: [1, .75, .4], highlightAmount: .35,
    hsl: { yellow: [-10, 1.15, .04], green: [-30, .8, 0], blue: [0, .6, 0] }, halation: .1 },
  { id: 'sienna', c: 'autumn', name: 'Sienna', // burnt red earth, dusky and dark
    exposure: -.14, curve: [[0, .04], [.5, .47], [1, .93]], contrast: 1.08, saturation: .95, mix: [1.12, .95, .86],
    shadowTint: [.5, .32, .3], shadowAmount: .4, hsl: { orange: [-14, 1.2, -.05], red: [6, 1.15, -.04], green: [-30, .45, -.08], blue: [0, .45, -.05] } },
  { id: 'chestnut', c: 'autumn', name: 'Chestnut', // dark woody brown, faded
    exposure: -.1, curve: [[0, .09], [.5, .48], [1, .9]], saturation: .7, mix: [1.06, 1, .86],
    hsl: { orange: [-6, 1.15, -.06], green: [-28, .45, -.08], blue: [0, .4, -.05], yellow: [-14, .7, -.06] } },
  { id: 'spice', c: 'autumn', name: 'Spice', // cinnamon: warm red-brown with teal shadows
    curve: [[0, .03], [.5, .5], [1, .95]], contrast: 1.06, saturation: .95, mix: [1.07, .98, .9],
    shadowTint: [.25, .48, .5], shadowAmount: .3, highlightTint: [1, .7, .5], highlightAmount: .3, hsl: { orange: [-8, 1.15, 0], green: [-20, .6, -.05] } },

  { id: 'dusk', c: 'mood', name: 'Dusk', // blue-violet evening, soft
    exposure: -.08, curve: [[0, .06], [.5, .49], [1, .93]], saturation: .8, mix: [.96, .96, 1.08],
    shadowTint: [.35, .35, .6], shadowAmount: .35, highlightTint: [1, .82, .78], highlightAmount: .2, hsl: { orange: [0, .9, .03] } },
  { id: 'hush', c: 'mood', name: 'Hush', // quiet grey-green, low contrast, near muted
    curve: [[0, .1], [.5, .5], [1, .9]], contrast: .9, saturation: .5, mix: [.98, 1.02, 1], shadowTint: [.4, .5, .45], shadowAmount: .25 },
  { id: 'cloud', c: 'mood', name: 'Cloud', // soft white-grey high key, milky
    exposure: .22, curve: [[0, .12], [.5, .58], [1, .96]], contrast: .85, saturation: .6, mix: [1, 1, 1.02] },
  { id: 'ink', c: 'mood', name: 'Ink', // dark, desaturated, crushed blue-black
    exposure: -.18, curve: [[0, 0], [.3, .2], [.6, .56], [1, .95]], contrast: 1.12, saturation: .6, mix: [.95, .98, 1.06],
    shadowTint: [.25, .3, .45], shadowAmount: .35 },
  { id: 'lilac', c: 'mood', name: 'Lilac', // whimsical pink-violet highlights
    exposure: .06, curve: [[0, .05], [.5, .53], [1, .97]], saturation: .88, mix: [1.04, .95, 1.04],
    highlightTint: [1, .7, .88], highlightAmount: .45, hsl: { blue: [14, .9, .04], green: [16, .7, 0] } },
  { id: 'seafoam', c: 'mood', name: 'Seafoam', // soft teal wash, pale skin
    curve: [[0, .06], [.5, .52], [1, .96]], saturation: .78, mix: [.95, 1.02, 1.02], shadowTint: [.3, .58, .56], shadowAmount: .35,
    hsl: { green: [30, .8, .04], blue: [-14, .85, .04], orange: [0, .92, .04] } },

  { id: 'linen', c: 'minimal', name: 'Linen', // clean warm neutral, barely there
    exposure: .08, curve: [[0, .03], [.5, .53], [1, .98]], saturation: .9, mix: [1.03, 1.01, .96] },
  { id: 'oat', c: 'minimal', name: 'Oat', // matte beige, lifted and soft
    curve: [[0, .12], [.5, .53], [1, .93]], contrast: .9, saturation: .7, mix: [1.05, 1.02, .9] },
  { id: 'pebble', c: 'minimal', name: 'Pebble', // bright neutral grey, cool and calm
    exposure: .14, curve: [[0, .02], [.5, .55], [1, .99]], contrast: 1.04, saturation: .6, mix: [.97, 1, 1.04] },
  { id: 'shell', c: 'minimal', name: 'Shell', // pale blush, pink-tinged whites
    exposure: .12, curve: [[0, .05], [.5, .55], [1, .98]], saturation: .82, mix: [1.04, .96, 1.01], highlightTint: [1, .8, .84], highlightAmount: .4 },
  { id: 'bay', c: 'minimal', name: 'Bay', // lagoon: clean cool blues, crisp whites
    exposure: .1, curve: [[0, .02], [.5, .54], [1, 1]], saturation: .88, mix: [.95, 1, 1.06],
    hsl: { blue: [-8, 1.05, .05], aqua: [0, 1.05, .04], orange: [4, .88, .04] } },
  { id: 'ivory', c: 'minimal', name: 'Ivory', // bright clean whites, faint warmth
    exposure: .24, curve: [[0, .03], [.5, .57], [1, 1]], contrast: 1.02, saturation: .88, mix: [1.02, 1.01, .98], highlightTint: [1, .96, .9], highlightAmount: .2 },

  { id: 'riviera', c: 'vintage', name: 'Riviera', // sunny 60s Mediterranean: warm, faded, turquoise water
    exposure: .08, curve: [[0, .07], [.5, .53], [1, .94]], saturation: .92, mix: [1.06, 1.02, .9],
    highlightTint: [1, .82, .6], highlightAmount: .25, hsl: { blue: [-18, 1.05, .04], aqua: [0, 1.1, .04], green: [-12, .8, 0] } },
  { id: 'postcard', c: 'vintage', name: 'Postcard', // printed postcard: punchy but faded, warm
    curve: [[0, .08], [.25, .26], [.5, .52], [.75, .8], [1, .92]], saturation: 1.05, mix: [1.05, 1, .9], rgb: { b: [[0, .1], [1, .9]] } },
  { id: 'y2016', c: 'vintage', name: '2016', // faded matte Instagram era: lifted blacks, teal-orange lite
    curve: [[0, .14], [.5, .52], [1, .95]], saturation: .85, shadowTint: [.3, .5, .55], shadowAmount: .3,
    highlightTint: [1, .82, .66], highlightAmount: .2 },

  /* ---------- Everyday: the most-used VSCO-style looks (see FILTERS.md for what each is modelled on) ---------- */
  { id: 'analog', c: 'everyday', name: 'Analog', // A6: subtle fade, orange highlights, green shadows, kind to skin
    curve: [[0, .07], [.25, .28], [.5, .52], [.75, .76], [1, .95]], saturation: .8,
    highlightTint: [1, .72, .45], highlightAmount: .3, shadowTint: [.32, .58, .42], shadowAmount: .35,
    hsl: { orange: [-3, 1.05, .02], yellow: [-10, .8, 0], green: [-22, .6, -.06], aqua: [0, .7, 0], blue: [-5, .65, 0] },
    grain: .2, grainSize: 1.3 },
  { id: 'candy', c: 'everyday', name: 'Candy', // C1: pink highlights, cyan-blue shadows, brighter and punchier, blues to cyan
    exposure: .1, curve: [[0, .01], [.25, .2], [.5, .53], [.75, .83], [1, 1]], saturation: 1.18,
    highlightTint: [1, .55, .72], highlightAmount: .42, shadowTint: [.2, .45, .72], shadowAmount: .42,
    hsl: { red: [-4, 1.1, 0], orange: [-5, 1, .03], blue: [-20, 1.15, .06], aqua: [-5, 1.15, .05], purple: [-10, 1.1, 0] } },
  { id: 'rust', c: 'everyday', name: 'Rust', // M5: warm rust, deep but desaturated hues, rolled-off highlights
    exposure: .06, curve: [[0, .05], [.3, .33], [.7, .71], [1, .88]], saturation: .78, mix: [1.07, 1, .88],
    highlightTint: [1, .66, .4], highlightAmount: .3,
    hsl: { red: [6, 1.1, -.1], orange: [-4, 1.15, -.04], yellow: [-14, .65, -.1], green: [-30, .5, -.12], aqua: [0, .5, -.05], blue: [-12, .45, -.1] },
    grain: .25, grainSize: 1.5 },
  { id: 'field', c: 'everyday', name: 'Field', // F2: desaturated, darker, blue-grey blacks, bright yellow-greens
    exposure: -.18, rgb: { r: [[0, .13], [1, .96]], g: [[0, .15], [1, .98]], b: [[0, .22], [1, .95]] },
    contrast: 1.1, saturation: .64,
    hsl: { yellow: [0, 1, .18], green: [-8, .95, .18], blue: [0, .45, 0], aqua: [0, .55, 0], orange: [0, .9, .04] } },
  { id: 'mattecool', c: 'everyday', name: 'Matte Cool', // HB1: light, cool, matte, teal greens
    exposure: .1, curve: [[0, .14], [.5, .53], [1, .94]], saturation: .78, mix: [.95, 1.01, 1.05],
    shadowTint: [.28, .5, .6], shadowAmount: .35, hsl: { green: [28, .75, .04], yellow: [12, .75, 0], orange: [0, .92, .05], aqua: [0, 1.1, .04] } },
  { id: 'mattewarm', c: 'everyday', name: 'Matte Warm', // HB2: same matte base, warmer
    curve: [[0, .13], [.5, .51], [1, .92]], saturation: .8, mix: [1.06, 1, .9], lift: [.02, 0, -.015],
    highlightTint: [1, .82, .6], highlightAmount: .25, hsl: { green: [-18, .7, 0], blue: [0, .75, 0], orange: [0, 1, .03] } },
  { id: 'natural', c: 'everyday', name: 'Natural', // AL3: true colour, gently brightened, crisp, even skin
    exposure: .08, curve: [[0, .01], [.25, .23], [.5, .53], [.75, .8], [1, .99]], contrast: 1.02, saturation: 1.08,
    hsl: { orange: [2, .88, .08], red: [0, .95, .02], green: [0, 1.05, .03], blue: [0, 1.05, .03], aqua: [0, 1.05, .02] } },
  { id: 'sunlit', c: 'everyday', name: 'Sunlit', // KK1: bright and warm, airy, bright reds pulled darker
    exposure: .14, curve: [[0, .03], [.25, .25], [.5, .55], [.75, .82], [1, .99]], mix: [1.05, 1.02, .9],
    highlightTint: [1, .88, .66], highlightAmount: .2, hsl: { red: [4, 1.1, -.25], orange: [2, 1.05, .02], yellow: [0, 1.15, .08], green: [-6, 1.05, .04] } },
  { id: 'goldenhour', c: 'everyday', name: 'Golden Hour', // KK2: warmer still, yellows brighter and louder
    exposure: .06, mix: [1.09, 1.02, .82], highlightTint: [1, .78, .4], highlightAmount: .32,
    hsl: { yellow: [-6, 1.35, .16], orange: [4, 1.12, .05], green: [-16, .9, .05], blue: [0, .8, 0] }, halation: .12 },
  { id: 'blush', c: 'everyday', name: 'Blush', // P5: lifted pastel, distinctly pink highlights and mint greens
    exposure: .15, curve: [[0, .1], [.5, .57], [1, .97]], saturation: .72, mix: [1.03, .97, 1.01], highlightTint: [1, .62, .78], highlightAmount: .45,
    hsl: { red: [-6, .85, .1], orange: [-6, .85, .08], green: [24, .6, .12], blue: [-8, .7, .12] } },
  { id: 'fern', c: 'everyday', name: 'Fern', // G3: green-tinted, soft and faded
    curve: [[0, .07], [.5, .5], [1, .95]], saturation: .82, mix: [.96, 1.04, .96],
    shadowTint: [.32, .58, .38], shadowAmount: .4, hsl: { green: [-8, 1.15, 0], yellow: [-12, 1, 0], orange: [0, .9, 0] } },
  { id: 'clean', c: 'everyday', name: 'Clean', // J2: bright, crisp, cool minimal
    exposure: .2, curve: [[0, 0], [.25, .23], [.5, .57], [.75, .84], [1, 1]], contrast: 1.04, saturation: .95, mix: [.96, 1, 1.05],
    hsl: { blue: [0, .9, .1], aqua: [0, .9, .08], orange: [4, .85, .06], yellow: [0, .75, .06], green: [6, .85, .04] } },
  { id: 'steel', c: 'everyday', name: 'Steel', // A5: dark grey-blue, red held back, cold and edgy
    exposure: -.12, curve: [[0, .1], [.5, .48], [1, .9]], rgb: { r: [[0, 0], [.5, .4], [1, .86]], b: [[0, .07], [1, 1]] },
    saturation: .55, mix: [.94, 1, 1.07], hsl: { red: [0, .6, -.05], orange: [0, .7, 0], blue: [0, 1.2, 0] } },
  { id: 'tealpop', c: 'everyday', name: 'Teal Pop', // BBMA: strong teal highlights
    curve: [[0, .02], [.5, .51], [1, .98]], saturation: 1.05, highlightTint: [.35, .85, .8], highlightAmount: .5,
    hsl: { aqua: [0, 1.3, 0], blue: [-14, 1.1, 0], orange: [0, 1, .02] } },
  { id: 'coldfront', c: 'everyday', name: 'Cold Front', // ACG: icy blue, darker, slight fade
    exposure: -.2, curve: [[0, .06], [.5, .47], [1, .94]], saturation: .66, mix: [.84, .97, 1.2],
    hsl: { orange: [0, .75, 0], blue: [0, 1.15, -.05], green: [20, .65, -.05] } },
  { id: 'cocoa', c: 'everyday', name: 'Cocoa', // A4/A10: dark, deep warm brown, browns boosted, greens killed
    exposure: -.16, curve: [[0, .05], [.5, .47], [1, .91]], saturation: 1, mix: [1.08, .99, .8], lift: [.025, .01, 0],
    hsl: { orange: [-8, 1.4, -.08], red: [10, 1.15, -.08], yellow: [-18, .85, -.08], green: [-36, .4, -.08], blue: [0, .45, 0], aqua: [0, .45, 0] } },

  /* ---------- Film: stocks and camera simulations ---------- */
  { id: 'tvset', c: 'film', name: 'TV Set', saturation: .78, mix: [1.06, 1.02, .88], scale: .82, fade: 22 / 255,
    softness: .7, grain: .55, grainSize: 3, vignette: .6, leak: 'tr', leakStrength: .35,
    fisheye: .45, border: [235, 228, 210] },
  { id: 'golden', c: 'film', name: 'Golden 400', curve: [[0, .04], [.25, .24], [.5, .52], [.75, .78], [1, .96]],
    contrast: .95, saturation: .92, mix: [1.04, 1, .92], shadowTint: [.35, .5, .45], shadowAmount: .18,
    highlightTint: [1, .82, .6], highlightAmount: .2, halation: .15, grain: .25, grainSize: 1.4, vignette: .25 },
  { id: 'portrait400', c: 'film', name: 'Portrait 400', // airy, low contrast, creamy warm skin, olive greens, pastel blues
    exposure: .12, curve: [[0, .06], [.25, .29], [.5, .55], [.75, .79], [1, .95]], contrast: .82, saturation: .82,
    mix: [1.04, 1, .93], highlightTint: [1, .86, .7], highlightAmount: .3,
    hsl: { orange: [-3, .95, .06], yellow: [-10, .8, .05], green: [-24, .65, .04], blue: [-8, .7, .06], aqua: [-6, .75, .05], red: [0, .9, 0] },
    grain: .2, grainSize: 1.3 },
  { id: 'portrait160', c: 'film', name: 'Portrait 160', // clean, bright, neutral-warm, low saturation
    exposure: .22, curve: [[0, .03], [.5, .56], [1, .98]], contrast: .9, saturation: .74, mix: [1.01, 1, .99],
    hsl: { orange: [2, .85, .07], green: [-10, .62, .06], blue: [-4, .68, .06] }, grain: .12, grainSize: 1.1 },
  { id: 'gold200', c: 'film', name: 'Gold 200', // warm yellow, saturated, contrasty, hot highlights
    curve: [[0, .02], [.25, .21], [.5, .52], [.75, .82], [1, .99]], contrast: 1.08, saturation: 1.1, mix: [1.07, 1.02, .82],
    highlightTint: [1, .82, .42], highlightAmount: .3,
    hsl: { yellow: [-5, 1.25, .06], green: [-16, .95, 0], blue: [0, .85, -.06], red: [0, 1.1, 0] },
    halation: .12, grain: .32, grainSize: 1.5, vignette: .3 },
  { id: 'max400', c: 'film', name: 'Max 400', // rosy consumer film: pink-warm skin, violet-tinged shadows, punchy
    curve: [[0, .02], [.25, .2], [.5, .51], [.75, .82], [1, .98]], contrast: 1.08, saturation: 1.1, mix: [1.05, .96, .96],
    shadowTint: [.48, .4, .58], shadowAmount: .2, highlightTint: [1, .76, .66], highlightAmount: .28,
    hsl: { red: [-6, 1, -.02], orange: [-6, 1.05, .05], yellow: [-4, 1.05, 0], green: [-4, .95, -.04], blue: [8, 1, -.04] }, grain: .38, grainSize: 1.6 },
  { id: 'plus200', c: 'film', name: 'Plus 200', // muted, warm yellow cast, olive greens, soft
    curve: [[0, .06], [.5, .52], [1, .93]], saturation: .82, mix: [1.05, 1.05, .8],
    hsl: { green: [-32, .75, 0], blue: [0, .6, 0], yellow: [-4, 1, .04] }, softness: .2, grain: .35, grainSize: 1.8 },
  { id: 'green400', c: 'film', name: 'Green 400', // green-cyan shadows, teal foliage; skin kept warm
    curve: [[0, .03], [.25, .23], [.5, .51], [.75, .79], [1, .97]], rgb: { g: [[0, .04], [.5, .51], [1, 1]] },
    contrast: 1.02, saturation: .92, mix: [.96, 1.03, .99], shadowTint: [.3, .56, .5], shadowAmount: .3,
    hsl: { green: [22, 1.1, -.04], yellow: [-8, .95, 0], orange: [-2, 1, .03], aqua: [-8, 1.1, 0], blue: [-12, .9, 0] }, grain: .35, grainSize: 1.5 },
  { id: 'mint400', c: 'film', name: 'Mint 400', // airy, very minty greens, pink-pastel skin, cyan shadows
    exposure: .2, curve: [[0, .08], [.5, .56], [1, .96]], contrast: .85, saturation: .78, mix: [.97, 1.01, 1.02],
    shadowTint: [.3, .58, .62], shadowAmount: .38,
    hsl: { green: [38, .7, .1], yellow: [20, .7, .06], aqua: [0, .85, .08], orange: [-8, .85, .08], red: [-6, .9, .04], blue: [-12, .75, .05] }, grain: .2, grainSize: 1.3 },
  { id: 'vivid100', c: 'film', name: 'Vivid 100', // fine-grain, cool-neutral, crisp; deep blues and clean reds
    curve: [[0, 0], [.25, .2], [.5, .5], [.75, .81], [1, 1]], contrast: 1.15, saturation: 1.2, mix: [.98, 1, 1.03],
    hsl: { red: [0, 1.05, -.05], orange: [3, .95, .02], blue: [-4, 1.25, -.08], aqua: [0, 1.2, -.04], green: [8, 1.12, -.05] }, grain: .1, grainSize: 1 },
  { id: 'slide50', c: 'film', name: 'Slide 50', // deep saturated slide: dense blues and greens, magenta-ish shadows
    curve: [[0, 0], [.2, .12], [.5, .48], [.8, .87], [1, 1]], rgb: { b: [[0, .04], [.5, .52], [1, .97]] },
    contrast: 1.12, saturation: 1.18, shadowTint: [.42, .3, .6], shadowAmount: .3,
    hsl: { green: [6, 1.3, -.1], blue: [0, 1.3, -.12], red: [0, .95, -.04], orange: [-3, .95, 0], aqua: [0, 1.25, -.08], purple: [0, 1.2, 0] },
    grain: .1, grainSize: 1, vignette: .3 },
  { id: 'slide100', c: 'film', name: 'Slide 100', // clean, cool, bright slide film
    exposure: .1, curve: [[0, 0], [.25, .21], [.5, .52], [.75, .83], [1, 1]], contrast: 1.06, saturation: 1.05, mix: [.93, 1, 1.08],
    hsl: { blue: [-6, 1.12, 0], aqua: [0, 1.12, 0], orange: [4, .9, .03], yellow: [10, .85, 0], green: [10, .95, 0] }, grain: .08, grainSize: 1 },
  { id: 'chrome64', c: 'film', name: 'Chrome 64', // deep reds, cyan-blue skies, rich but open shadows
    curve: [[0, .01], [.25, .19], [.5, .49], [.75, .8], [1, .97]], rgb: { r: [[0, 0], [.5, .52], [1, 1]] },
    contrast: 1.12, saturation: 1.08, mix: [1.04, .99, .93],
    hsl: { red: [-3, 1.15, -.1], blue: [-16, 1.1, -.06], yellow: [-5, 1.15, 0], green: [-12, .85, -.08], orange: [0, 1, -.02] },
    grain: .25, grainSize: 1.3, vignette: .3 },
  { id: 'punch800', c: 'film', name: 'Punch 800', // high-ISO punch: warm highlights against blue shadows, grainy
    curve: [[0, .03], [.25, .2], [.5, .52], [.75, .84], [1, 1]], contrast: 1.12, saturation: 1.25, mix: [1.04, 1, .94],
    shadowTint: [.2, .4, .66], shadowAmount: .35, highlightTint: [1, .78, .5], highlightAmount: .25,
    hsl: { blue: [8, 1.2, -.06], red: [0, 1.05, 0], green: [-8, 1.15, -.04], orange: [-3, 1, .05] }, grain: .55, grainSize: 2, vignette: .5 },
  { id: 'reportage', c: 'film', name: 'Reportage', // classic-chrome style: muted, hard shadows, cool, cyan-leaning blues
    curve: [[0, 0], [.25, .17], [.5, .5], [.75, .8], [1, .96]], contrast: 1.12, saturation: .7, mix: [.95, 1, 1.05],
    shadowTint: [.35, .46, .58], shadowAmount: .32,
    hsl: { red: [0, .78, -.05], orange: [2, .85, 0], yellow: [-6, .5, -.06], green: [-12, .45, -.08], blue: [-20, 1.15, -.05], aqua: [0, 1.05, 0] } },
  { id: 'negative', c: 'film', name: 'Negative', // classic-neg style: hard tones, olive greens, teal shadows, warm highlights, magenta reds
    curve: [[0, .02], [.25, .17], [.5, .5], [.75, .83], [1, .98]], contrast: 1.14, saturation: .85, mix: [1.03, 1, .96],
    shadowTint: [.2, .52, .55], shadowAmount: .45, highlightTint: [1, .8, .6], highlightAmount: .35,
    hsl: { red: [-12, 1.05, 0], orange: [-5, .92, 0], yellow: [-18, .75, 0], green: [-30, .65, -.06], blue: [-22, .9, 0] }, grain: .2, grainSize: 1.3 },
  { id: 'nostalgia', c: 'film', name: 'Nostalgia', // nostalgic-neg style: strong amber highlights, rich reds, soft-contrast shadows with a cool lift
    curve: [[0, .04], [.25, .23], [.5, .51], [.75, .79], [1, .96]], contrast: 1.0, saturation: 1.1, mix: [1.03, 1, .93], lift: [0, .005, .02],
    highlightTint: [1, .62, .2], highlightAmount: .6, hsl: { yellow: [-10, 1.15, 0], green: [-20, .8, 0], red: [6, 1.12, -.03], blue: [-6, .85, 0] },
    grain: .2, grainSize: 1.4 },
  { id: 'cineflat', c: 'film', name: 'Cinema Flat', // eterna style: flat, low saturation, cyan-teal greens and shadows
    curve: [[0, .07], [.25, .27], [.5, .5], [.75, .72], [1, .93]], contrast: .88, saturation: .58, mix: [.95, 1.02, 1.01],
    shadowTint: [.25, .52, .55], shadowAmount: .42, hsl: { green: [32, .75, 0], yellow: [10, .7, 0], blue: [-10, .85, 0], orange: [-2, .9, .02] } },
  { id: 'coastfog', c: 'film', name: 'Coast Fog', exposure: .1, curve: [[0, .08], [.25, .28], [.5, .52], [.75, .74], [1, .92]],
    contrast: .85, saturation: .6, mix: [.96, 1, 1.04], scale: .9, fade: .07, shadowTint: [.45, .55, .6],
    shadowAmount: .2, softness: .4, grain: .3, grainSize: 1.6, vignette: .2 },

  /* ---------- Vintage ---------- */
  { id: 'expired', c: 'vintage', name: 'Expired', saturation: .85, mix: [1.08, .97, .94], scale: .9, fade: .06,
    highlightTint: [1, .7, .75], highlightAmount: .18, halation: .2, grain: .45, grainSize: 2.2,
    vignette: .4, leak: 'bl', leakStrength: .45 },
  { id: 'faded70', c: 'vintage', name: 'Faded ’70s', // yellow-green cast, very lifted, blue crushed in highlights
    curve: [[0, .14], [.3, .34], [.6, .62], [1, .88]], rgb: { b: [[0, .2], [1, .74]], r: [[0, .04], [1, 1]] },
    contrast: .88, saturation: .7, mix: [1.05, 1.04, .9], hsl: { green: [-20, .75, 0], blue: [-10, .6, 0], red: [10, .9, 0] },
    grain: .4, grainSize: 2, vignette: .35 },
  { id: 'drugstore', c: 'vintage', name: 'Drugstore ’99', // 90s minilab print: punchy, green-cyan shadows, warm-yellow highlights
    curve: [[0, .03], [.25, .21], [.5, .52], [.75, .83], [1, .96]], saturation: 1.12, mix: [1.03, 1.02, .9],
    shadowTint: [.3, .55, .5], shadowAmount: .35, highlightTint: [1, .88, .55], highlightAmount: .3,
    hsl: { orange: [-4, 1.05, .02], green: [-8, 1.05, -.04], blue: [-6, 1.05, 0], red: [0, 1.1, 0] }, grain: .3, grainSize: 1.6, vignette: .3 },
  { id: 'summer79', c: 'vintage', name: 'Summer ’79', // sun-bleached: peach highlights, cyan shadows, washed
    exposure: .18, curve: [[0, .08], [.3, .36], [.7, .76], [1, .95]], rgb: { r: [[0, .05], [1, 1]], b: [[0, .1], [1, .8]] },
    contrast: .88, saturation: .66, mix: [1.05, 1.01, .92], shadowTint: [.25, .6, .62], shadowAmount: .3,
    hsl: { blue: [-18, .8, .08], green: [-12, .7, .06] }, halation: .2, grain: .35, grainSize: 1.8, vignette: .2,
    leak: 'tr', leakStrength: .22 },
  { id: 'mall86', c: 'vintage', name: 'Mall ’86', // magenta-pink cast, purple shadows
    curve: [[0, .05], [.5, .52], [1, .95]], contrast: .95, saturation: .9, mix: [1.05, .93, 1.03], fade: .03,
    shadowTint: [.48, .38, .65], shadowAmount: .35, highlightTint: [1, .7, .85], highlightAmount: .3,
    hsl: { blue: [20, .9, 0], green: [10, .7, 0] }, grain: .4, grainSize: 1.8, vignette: .3 },
  { id: 'album', c: 'vintage', name: 'Album', // aged print: yellowed whites, brown desaturated colour
    curve: [[0, .08], [.5, .5], [1, .88]], rgb: { b: [[0, .06], [1, .72]] }, contrast: .9, saturation: .5,
    mix: [1.06, 1, .84], fade: .05, highlightTint: [1, .88, .62], highlightAmount: .25,
    softness: .35, grain: .3, grainSize: 2, vignette: .55 },
  { id: 'cross', c: 'vintage', name: 'Cross', curve: [[0, .02], [.5, .5], [1, .98]],
    rgb: { r: [[0, 0], [.25, .17], [.75, .85], [1, 1]], g: [[0, .02], [.25, .22], [.75, .82], [1, 1]], b: [[0, .2], [1, .78]] },
    contrast: 1.08, saturation: 1.12, grain: .3, grainSize: 1.4, vignette: .35 },
  { id: 'bypass', c: 'vintage', name: 'Bypass', curve: [[0, 0], [.25, .18], [.5, .5], [.75, .84], [1, 1]],
    contrast: 1.25, saturation: .45, mix: [1, 1.01, 1.03], grain: .35, grainSize: 1.3, vignette: .4 },

  /* ---------- Retro camera ---------- */
  { id: 'disposable', c: 'retro', name: 'Disposable', // warm yellow overexposed point-and-shoot, green shadows, harsh flash
    exposure: .12, curve: [[0, .04], [.25, .22], [.5, .55], [.75, .86], [1, .99]], contrast: 1.12, saturation: 1.08, mix: [1.06, 1.04, .82],
    shadowTint: [.35, .55, .35], shadowAmount: .3, hsl: { orange: [-4, 1.1, .04], yellow: [-4, 1.15, .05], green: [-14, 1.05, 0] },
    softness: .35, halation: .12, grain: .5, grainSize: 2, chroma: .08, vignette: .7 },
  { id: 'instant', c: 'retro', name: 'Instant', // warm cream, low contrast, lifted blue blacks, soft
    curve: [[0, .07], [.5, .52], [1, .93]], rgb: { r: [[0, .05], [1, .98]], b: [[0, .15], [1, .86]] },
    contrast: .88, saturation: .78, mix: [1.04, 1.02, .94], highlightTint: [1, .93, .75], highlightAmount: .2,
    hsl: { green: [-14, .7, 0], blue: [-10, .7, 0] }, softness: .45, grain: .2, grainSize: 1.4, vignette: .35 },
  { id: 'instantcool', c: 'retro', name: 'Instant Cool', // cyan-green instant film, creamy highlights, faded; skin protected
    curve: [[0, .09], [.5, .53], [1, .94]], contrast: .9, saturation: .72, mix: [.92, 1.03, 1.04], fade: .03,
    shadowTint: [.22, .6, .6], shadowAmount: .38, highlightTint: [1, .95, .82], highlightAmount: .25,
    hsl: { orange: [4, .95, .07], green: [26, .75, 0], red: [-6, .9, .02] }, softness: .4, grain: .2, grainSize: 1.4, vignette: .3 },
  { id: 'digicam', c: 'retro', name: 'Digicam ’04', // cool auto white balance, clipped highlights, digital noise
    exposure: .12, curve: [[0, 0], [.5, .56], [.85, .99], [1, 1]], contrast: 1.1, saturation: 1.18, mix: [.95, 1, 1.07],
    hsl: { blue: [-8, 1.2, .05], green: [10, 1.1, 0], orange: [6, .9, .05] },
    halation: .15, halTint: WHITE, halThreshold: .7, chroma: .25, grain: .08, grainSize: 1 },
  { id: 'ccd', c: 'retro', name: 'CCD', // magenta-cool glow, blooming highlights
    exposure: .08, curve: [[0, .02], [.5, .54], [.9, .98], [1, 1]], contrast: 1.05, saturation: 1.05, mix: [1.03, .95, 1.08],
    halation: .5, halTint: [1, .92, .98], halThreshold: .52, shadowTint: [.42, .38, .62], shadowAmount: .3,
    hsl: { blue: [12, 1.1, 0], red: [-8, 1.05, 0] }, chroma: .2, vignette: .1 },
  { id: 'flash35', c: 'retro', name: 'Flash 35', // night flash: hot bright skin, background falls to cool dark
    exposure: .05, curve: [[0, 0], [.2, .06], [.5, .5], [.8, .92], [1, 1]], contrast: 1.2, saturation: 1.02, mix: [1.03, 1, .95],
    hsl: { orange: [-2, 1.05, .14], red: [0, 1.05, .04], blue: [0, .7, -.18], green: [10, .6, -.18], aqua: [0, .7, -.15] },
    halation: .2, grain: .45, grainSize: 1.8, vignette: .65 },
  { id: 'super8', c: 'retro', name: 'Super 8', // orange-amber home movie: warm, soft, heavy grain
    curve: [[0, .06], [.5, .5], [1, .9]], contrast: 1.05, saturation: .9, mix: [1.15, .98, .72], fade: .02,
    hsl: { blue: [-10, .5, 0], green: [-30, .7, 0], orange: [-4, 1.1, 0] }, softness: .6, halation: .25, grain: .7, grainSize: 2.6,
    vignette: .6, leak: 'bl', leakStrength: .2 },
  { id: 'camcorder', c: 'retro', name: 'Camcorder', // oversaturated reds, magenta tint, soft video
    curve: [[0, .04], [.5, .52], [1, .96]], contrast: 1.1, saturation: 1.25, mix: [1.04, .97, 1.04], fade: .04,
    hsl: { red: [0, 1.25, 0], blue: [10, 1.15, 0], green: [10, .85, 0] }, softness: .5, chroma: .3, grain: .2, grainSize: 1, vignette: .15 },
  { id: 'toycam', c: 'retro', name: 'Toy Cam', // plastic lens: saturated, cross-shifted, dark corners
    curve: [[0, 0], [.25, .16], [.5, .5], [.75, .85], [1, 1]], rgb: { b: [[0, .08], [1, .88]] },
    contrast: 1.2, saturation: 1.3, hsl: { green: [-12, 1.1, 0], blue: [-10, 1.2, 0] }, softness: .3, grain: .4, grainSize: 1.6, vignette: .85 },

  /* ---------- Cinematic ---------- */
  { id: 'sodium', c: 'cine', name: 'Sodium', curve: [[0, .02], [.25, .2], [.5, .5], [.75, .8], [1, .97]],
    contrast: 1.08, saturation: .85, mix: [1.03, .98, .95], shadowTint: [.1, .45, .5], shadowAmount: .35,
    highlightTint: [1, .6, .25], highlightAmount: .3, halation: .45, grain: .3, grainSize: 1.2, vignette: .45 },
  { id: 'observer', c: 'cine', name: 'Observer', contrast: .92, saturation: .7, mix: [.98, 1, 1.03], scale: .94, fade: .05,
    shadowTint: [.3, .4, .5], shadowAmount: .22, highlightTint: [.95, .9, .8], highlightAmount: .12,
    halation: .1, softness: .3, grain: .4, grainSize: 2, vignette: .65 },
  { id: 'blockbuster', c: 'cine', name: 'Blockbuster', // hard teal and orange: skin pushed orange, everything else teal
    curve: [[0, .02], [.25, .2], [.5, .5], [.75, .81], [1, .98]], contrast: 1.12, saturation: 1,
    shadowTint: [.1, .5, .58], shadowAmount: .55, highlightTint: [1, .62, .32], highlightAmount: .38,
    hsl: { orange: [-2, 1.2, .03], yellow: [-12, 1.1, 0], green: [45, .7, -.05], blue: [-25, 1.1, 0], red: [8, 1, 0] },
    grain: .15, grainSize: 1.2, vignette: .35 },
  { id: 'neon', c: 'cine', name: 'Neon Night', // magenta and cyan, glowing lights
    curve: [[0, 0], [.25, .16], [.5, .48], [.75, .8], [1, 1]], contrast: 1.12, saturation: 1.15, mix: [1, .95, 1.06],
    shadowTint: [.2, .3, .65], shadowAmount: .4, highlightTint: [1, .5, .78], highlightAmount: .25,
    hsl: { blue: [10, 1.2, 0], red: [-12, 1.15, 0], green: [35, .8, 0] },
    halation: .5, halThreshold: .55, grain: .3, grainSize: 1.4, vignette: .4 },
  { id: 'cine800t', c: 'cine', name: '800T', // tungsten film: blue cast, red halation, teal shadows, warm skin
    curve: [[0, .04], [.25, .23], [.5, .51], [.75, .79], [1, .97]], contrast: 1.02, saturation: .92, mix: [.86, .97, 1.15],
    shadowTint: [.15, .48, .58], shadowAmount: .3, hsl: { orange: [-4, 1.25, .04], red: [0, 1.15, 0], green: [25, .75, 0], yellow: [-10, 1.1, 0] },
    halation: .65, halThreshold: .55, grain: .4, grainSize: 1.6, vignette: .3 },
  { id: 'overcast', c: 'cine', name: 'Overcast', // moody desaturated, green-teal shadows, dark
    exposure: -.18, curve: [[0, .04], [.5, .48], [1, .93]], contrast: 1.06, saturation: .55, fade: .03,
    shadowTint: [.28, .48, .45], shadowAmount: .45, hsl: { green: [10, .55, -.08], orange: [0, .8, 0], blue: [-6, .6, -.05] },
    grain: .3, grainSize: 1.5, vignette: .55 },
  { id: 'dune', c: 'cine', name: 'Dune', // desert: everything pulled to sand and amber, blues killed
    curve: [[0, .03], [.5, .51], [1, .95]], contrast: 1.06, saturation: .8, mix: [1.1, 1, .8], fade: .03,
    shadowTint: [.5, .35, .25], shadowAmount: .3, highlightTint: [1, .78, .5], highlightAmount: .35,
    hsl: { blue: [-60, .35, 0], aqua: [-60, .4, 0], green: [-40, .5, 0], yellow: [-8, .9, 0] }, halation: .1, grain: .25, grainSize: 1.4, vignette: .3 },
  { id: 'glasshouse', c: 'cine', name: 'Glasshouse', // cold green digital-noir; skin kept neutral
    curve: [[0, .02], [.25, .18], [.5, .5], [.75, .82], [1, .97]], contrast: 1.15, saturation: .7, mix: [.94, 1.04, .94],
    shadowTint: [.25, .52, .35], shadowAmount: .32, hsl: { orange: [6, .8, .03], green: [-10, 1.1, -.05], blue: [-30, .6, 0] }, grain: .25, grainSize: 1.3, vignette: .5 },
  { id: 'jade', c: 'cine', name: 'Jade', // dark green-yellow night, saturated, glowing highlights
    exposure: -.15, curve: [[0, .02], [.25, .16], [.5, .47], [.75, .8], [1, .97]], contrast: 1.15, saturation: 1.12, mix: [.96, 1.08, .86],
    shadowTint: [.25, .55, .3], shadowAmount: .45,
    hsl: { yellow: [-10, 1.2, 0], green: [-15, 1.15, 0], red: [-6, 1.15, 0], blue: [30, .7, -.05] },
    halation: .35, halTint: [1, .8, .3], softness: .25, grain: .35, grainSize: 1.6, vignette: .5 },
  { id: 'arctic', c: 'cine', name: 'Arctic', // cold blue, near-monochrome, bright whites
    exposure: .05, curve: [[0, .04], [.5, .52], [1, 1]], contrast: 1.05, saturation: .4, mix: [.88, .98, 1.14],
    shadowTint: [.25, .4, .65], shadowAmount: .4, hsl: { blue: [0, 1.6, 0], aqua: [0, 1.4, 0] }, vignette: .3 },

  /* ---------- B&W (channel curves act as colour filters before desaturation) ---------- */
  { id: 'silver', c: 'bw', name: 'Silver 400', curve: [[0, .02], [.25, .2], [.5, .5], [.75, .8], [1, .98]],
    contrast: 1.15, saturation: 0, grain: .6, grainSize: 1.8, vignette: .35 },
  { id: 'push1600', c: 'bw', name: 'Push 1600', // pushed film: hard contrast, bright whites, coarse grain
    curve: [[0, 0], [.3, .18], [.5, .48], [.7, .8], [1, 1]], rgb: { b: [[0, 0], [1, .85]] }, contrast: 1.2, saturation: 0,
    grain: .9, grainSize: 2.6, vignette: .5 },
  { id: 'pearl', c: 'bw', name: 'Pearl', // soft, lifted, warm-white
    curve: [[0, .1], [.5, .58], [1, .97]], contrast: .8, saturation: 0, highlightTint: [1, .95, .86], highlightAmount: .25,
    softness: .3, grain: .25, grainSize: 1.4, vignette: .2 },
  { id: 'selenium', c: 'bw', name: 'Selenium', // cool violet-toned shadows
    curve: [[0, .01], [.25, .2], [.5, .5], [.75, .8], [1, .98]], contrast: 1.1, saturation: 0,
    shadowTint: [.45, .38, .62], shadowAmount: .55, highlightTint: [.92, .93, 1], highlightAmount: .15, grain: .35, grainSize: 1.6, vignette: .35 },
  { id: 'sepia', c: 'bw', name: 'Sepia', curve: [[0, .04], [.5, .5], [1, .95]], contrast: 1.02, saturation: 0,
    shadowTint: [.6, .38, .2], shadowAmount: .65, highlightTint: [1, .88, .62], highlightAmount: .5, fade: .03,
    grain: .35, grainSize: 2, vignette: .4 },
  { id: 'noir', c: 'bw', name: 'Noir', // red-filter drama: dark skies, bright skin, deep blacks
    curve: [[0, 0], [.25, .14], [.6, .63], [1, 1]], rgb: { r: [[0, 0], [.5, .64], [1, 1]], b: [[0, 0], [1, .5]], g: [[0, 0], [1, .85]] },
    contrast: 1.25, saturation: 0, grain: .4, grainSize: 1.5, vignette: .6 },
  { id: 'ghost', c: 'bw', name: 'Ghost', rgb: { g: [[0, 0], [.5, .82], [1, 1]], b: [[0, 0], [1, .5]] },
    contrast: 1.2, saturation: 0, halation: .4, halTint: WHITE, halThreshold: .55, grain: .3, grainSize: 1.5, vignette: .3 },
  { id: 'finegrain', c: 'bw', name: 'Fine Grain', // high-key, smooth, slightly cool; green filter lightens foliage
    exposure: .12, curve: [[0, .03], [.25, .26], [.5, .58], [.75, .84], [1, .99]], rgb: { g: [[0, 0], [.5, .6], [1, 1]], r: [[0, 0], [1, .85]] },
    contrast: 1.05, saturation: 0, shadowTint: [.42, .47, .58], shadowAmount: .35, grain: .1, grainSize: 1 },
  { id: 'street400', c: 'bw', name: 'Street 400', // gritty, lifted blacks, warm-toned paper
    curve: [[0, .1], [.25, .22], [.5, .5], [.75, .8], [1, .93]], contrast: 1.15, saturation: 0,
    shadowTint: [.58, .44, .3], shadowAmount: .5, highlightTint: [1, .88, .7], highlightAmount: .5, grain: .7, grainSize: 2, vignette: .45 },

  /* ---------- Soft ---------- */
  { id: 'pastel', c: 'soft', name: 'Pastel', // candy pastel: every colour lifted and lightened
    exposure: .22, curve: [[0, .1], [.5, .58], [1, .97]], contrast: .8, saturation: .72,
    shadowTint: [.6, .52, .68], shadowAmount: .3, highlightTint: [1, .88, .92], highlightAmount: .25,
    hsl: { red: [10, .8, .12], orange: [0, .8, .1], yellow: [0, .8, .12], green: [10, .7, .15], blue: [10, .75, .15] }, softness: .2 },
  { id: 'dreamy', c: 'soft', name: 'Dreamy', // strong golden glow, soft focus
    exposure: .15, curve: [[0, .05], [.5, .55], [1, .97]], contrast: .9, saturation: .9, fade: .03, mix: [1.04, 1.01, .94],
    highlightTint: [1, .86, .66], highlightAmount: .3, halation: .65, halTint: [1, .88, .7], halThreshold: .42, softness: .6 },
  { id: 'haze', c: 'soft', name: 'Haze', // cool blue fog, milky shadows
    curve: [[0, .16], [.5, .56], [1, .94]], contrast: .85, saturation: .6, mix: [.95, 1, 1.06], lift: [0, .01, .04],
    halation: .35, halTint: [.9, .95, 1], halThreshold: .5, hsl: { orange: [0, .85, .04], green: [15, .7, .05] }, grain: .12, grainSize: 1.2 },
  { id: 'milk', c: 'soft', name: 'Milk', // creamy high-key, warm whites, almost colourless
    exposure: .3, curve: [[0, .1], [.5, .58], [1, .97]], contrast: .85, saturation: .45, mix: [1.03, 1.01, .94], fade: .03,
    hsl: { orange: [0, 1.3, .03], red: [0, 1.2, 0] }, softness: .2 },
  { id: 'peach', c: 'soft', name: 'Peach', // peach and coral: oranges and reds pushed to pink-peach
    exposure: .1, curve: [[0, .05], [.5, .53], [1, .97]], saturation: .9, mix: [1.07, .98, .95], fade: .03,
    shadowTint: [.62, .45, .45], shadowAmount: .25, highlightTint: [1, .78, .68], highlightAmount: .35,
    hsl: { orange: [-8, 1.1, .06], red: [-10, .95, .08], yellow: [-15, .85, .05], green: [-10, .7, .05], blue: [20, .6, .05] }, softness: .2 },
  { id: 'lavender', c: 'soft', name: 'Lavender', // blues lean violet, lilac shadows
    exposure: .1, curve: [[0, .06], [.5, .53], [1, .96]], saturation: .8, mix: [1, .96, 1.05], fade: .04,
    shadowTint: [.52, .44, .68], shadowAmount: .38, highlightTint: [.97, .92, 1], highlightAmount: .2,
    hsl: { blue: [16, .85, .06], aqua: [24, .75, .02], green: [16, .6, .05] }, softness: .2 },
  { id: 'cotton', c: 'soft', name: 'Sea Glass', // soft high-key sea-glass: minty greens and aqua blues, skin kept peachy
    exposure: .24, curve: [[0, .1], [.5, .57], [1, .97]], contrast: .82, saturation: .72, mix: [.97, 1.02, 1.02], lift: [0, .02, .02],
    shadowTint: [.36, .62, .6], shadowAmount: .28, hsl: { green: [45, .62, .12], blue: [-30, .65, .1], yellow: [16, .62, .06], orange: [0, 1, .08], red: [0, .95, .04] },
    softness: .5, grain: .12, grainSize: 1 }
];

// retired ids that saved looks, favourites or drafts may still reference
const ALIASES = { cool400: 'coldfront' };
const ORIGINALS = ['tvset', 'golden', 'sodium', 'coastfog', 'observer', 'expired', 'bypass', 'silver'];
const PRESETS = LIST.map(p => ({ ...DEFAULTS, ...p }));
const BY_ID = {};
for (const p of PRESETS) BY_ID[p.id] = p;
const inCollection = (p, cid) => {
  const c = COLLECTIONS.find(x => x.id === cid);
  return c && c.ids ? c.ids.includes(p.id) : p.c === cid;
};
const itemsIn = cid => {
  const c = COLLECTIONS.find(x => x.id === cid);
  return c && c.ids ? c.ids.map(id => BY_ID[id]).filter(Boolean) : PRESETS.filter(p => p.c === cid);
};

window.DRPresets = { DEFAULTS, COLLECTIONS, PRESETS, BY_ID, inCollection, itemsIn, get: id => BY_ID[id] || BY_ID[ALIASES[id]] || PRESETS[0],
  // the owner's originals open at full strength; everything else at 80%, like Esti
  defaultStrength: id => (ORIGINALS.includes(id) ? 1 : (BY_ID[id] && BY_ID[id].strength0) || 0.8) };
})();
