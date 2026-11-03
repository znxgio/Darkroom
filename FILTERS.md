# Filter research and design notes

Why the old presets looked the same, what makes popular film and VSCO looks recognizable, and how the library was rebuilt and checked.

## 1. The problem, measured

I rendered every preset on a test card of four real photos (portrait, grass + skin + red plaid, blue lake, red hat + denim + foliage). For every pair of presets I computed the average perceptual colour difference (mean CIELAB ΔE76 per pixel).
- Grain, vignette, fisheye and light leaks were switched off, so only colour and tone count.
- As a rough guide: below ~5 is hard to tell apart in a small thumbnail, and above ~10 is clearly different.

| | Before (47 presets) | After (78 presets) |
|---|---|---|
| Median distance to the nearest other preset | **4.7** | **6.4** |
| Closest pair | 1.9 (Silver 400 / Street 400) | 4.3 (Silver 400 / Selenium, both B&W) |
| Pairs under 6 | 33 of 1,081 | 17 of 3,003 |
| Median distance from the original photo | 13.3 | 14.8 |

**Cause:** almost every old preset was built from the same three moves: a gentle S-curve, a saturation trim, and a soft shadow/highlight tint. Shifting those a little produces looks that are technically different but read as the same filter.

Most of the remaining close pairs involve your original eight presets, which I didn't change. TV Set is closer to others on this measure than it looks, because its identity is texture: fisheye, paper border, heavy grain.

## 2. What makes the popular looks recognizable

Sources are listed at the end. No source publishes exact VSCO numbers: VSCO's filters are proprietary LUTs, and people who try to recreate them report "very close, but completely off on some images". So these are reconstructions of the *character* of each look, built from published descriptions.

**Three ingredients matter more than anything else:**
1. **Colour-specific shifts (HSL).** Changing particular hues, not the whole image. Moving greens toward yellow-olive (Kodak) or toward teal (Fuji), skies toward cyan, and protecting or warming skin are the biggest differences between film stocks. Reviewers repeatedly call greens "the most visible difference" between Portra and Fuji 400H.
2. **Tinted blacks and highlights.**
   - C1: pink highlights, blue shadows.
   - A6: orange highlights, green shadows.
   - F2: blacks measured at about R 0.13, G 0.14, B 0.17, i.e. blue-grey.
   - BBMA: teal highlights.
3. **Contrast and fade shape.** How lifted the blacks are (matte), how the highlights roll off (M5 "crushes" them), and how hard the shadows are (Classic Chrome).

Grain, halation and vignette add texture, but they don't make a look recognizable.

**What I took from each reference:**

| Reference look | What sources describe | Darkroom preset |
|---|---|---|
| VSCO A6 | subtle fade, orange highlights, green shadows, brown and kind to skin, low saturation | **Analog** |
| VSCO C1 | pink highlights, blue shadows, more saturation, brightness and contrast; blues go cyan | **Candy** |
| VSCO M5 | lightens and warms, rust colour, hues deepened *and* desaturated, strong on yellow/green/blue, crushed highlights | **Rust** |
| VSCO F2 | desaturated, darker, blue-grey blacks, yellow/green brighter, blue desaturated | **Field** |
| VSCO HB1 / HB2 | cool vs warm versions of a matte, faded look | **Matte Cool / Matte Warm** |
| VSCO AL3 | keeps the original colours, softer tones, even skin | **Natural** |
| VSCO KK1 / KK2 | warm; KK1 darkens bright reds; KK2 is warmer with brighter yellows | **Sunlit / Golden Hour** |
| VSCO A4 / A10 | warm, brown saturation boosted | **Cocoa** |
| VSCO A5 | stronger fade, red held back, cool and edgy | **Steel** |
| VSCO P5, G3, J2 | pastel; green-tinted; minimal and clean | **Blush, Fern, Clean** |
| VSCO BBMA / ACG | teal highlights; cold and darker | **Teal Pop / Cold Front** |
| Portra 400 | balanced, airy, the best skin, warm greens, forgiving highlights | **Portrait 400** |
| Portra 160 | cleaner and softer than 400 | **Portrait 160** |
| Gold 200 | warm, contrastier, burns highlights sooner | **Gold 200** |
| Fuji Pro 400H | cooler, greens and blues stand out, "soft glow" skin | **Mint 400** |
| Superia 400 | green-cyan shadows, teal foliage | **Green 400** |
| Ultramax / ColorPlus | consumer warm and punchy / muted, yellow and cheap | **Max 400 / Plus 200** |
| Ektar 100, Velvia 50, E100 | saturated and fine grained; deep slide colour; clean cool slide | **Vivid 100, Slide 50, Slide 100** |
| Kodachrome 64 | deep reds, cyan-blue skies, dense shadows | **Chrome 64** |
| Lomo 800 | saturated, grainy, high-ISO punch | **Punch 800** |
| Cinestill 800T | tungsten blue cast, red halation around lights, stylised shadows | **800T** |
| Fujifilm Classic Chrome | desaturated, harder contrast, blues keep vibrance and lean cyan | **Reportage** |
| Fujifilm Classic Neg | warmer, more contrast than Classic Chrome, medium-low saturation, loosely based on Superia | **Negative** |
| Fujifilm Nostalgic Neg | 1970s American colour prints: amber highlights, softer shadows, more saturated | **Nostalgia** |
| Fujifilm Eterna | flat, low saturation, cinematic | **Cinema Flat** |

Names are my own, so the app doesn't use VSCO's or film makers' trademarks. The comments in `js/presets.js` say which look each preset is modelled on.

## 3. Engine changes that make the looks possible

- **HSL per colour band** in the grade shader: 8 bands (red, orange/skin, yellow, green, aqua, blue, purple, magenta), each with a hue shift, saturation multiplier and brightness shift.
  - Neighbouring bands blend smoothly, and near-grey pixels are left alone.
  - This is what lets Green 400 turn foliage teal while keeping skin warm, or Dune remove blue from the sky.
- **Tinted black lift** (`lift`), for matte looks with coloured blacks.
- **Per-channel curves** already existed and are now used deliberately. For example, F2's measured blue-grey blacks, and colour-filter effects in B&W (Noir's red filter darkens skies; Fine Grain's green filter lightens foliage).
- **Filter layering:** tap **+ Layer** next to the strength, then pick any preset to stack it on top of the base, with its own strength.
  - Thumbnails in layer mode preview *your base plus that preset*.
  - The base strength still controls the whole stack.
  - Saved looks, batch, undo and drafts include the layer.

**None of this changes your original eight.** TV Set, Golden 400, Sodium, Coast Fog, Observer, Expired, Bypass and Silver 400 still render pixel-identical to the very first version (verified: maximum difference 0).

## 4. Library now: 78 presets

- **Popular** (16, a curated mix of the most-used looks above, plus TV Set and Silver 400)
- **Everyday** (16, the VSCO-style looks)
- **Film** (19)
- **Vintage** (8)
- **Retro camera** (9)
- **Cinematic** (10)
- **B&W** (9)
- **Soft** (7)

Retired: Cool 400. Saved looks and favourites that used it now get Cold Front.

## 5. How it was tuned, and limits

- Each look was built from its signature traits, rendered on the test card, checked by eye for broken skin tones, and re-tuned until no new preset was close to another.
  - Fixed along the way: green skin in Green 400, teal-grey skin in Mint/Instant Cool, neon lips in Max 400 and Slide 50, and faces crushed to black in Noir and Push 1600.
- To re-run the audit after tweaking presets:
  - `node tools/filter-audit.js out.json your-photo.jpg`
  - `node tools/filter-distance.js out.json 6`
- **Limits:**
  - The test photos were stock images, not your R10 files.
  - "Similar" is measured on colour and tone only.
  - Taste is my judgment.
  - B&W presets are inherently closer on this measure, since they can only differ in tone and toning.

## Sources

- VSCO filter descriptions: [VSCO Photo Filters](https://www.vsco.co/features/photo-filters), [Daily Dot: best VSCO filters](https://dailydot.com/best-vsco-filters), [sspai VSCO filter series (Chinese, per-filter breakdowns)](https://sspai.com/post/39273), [MacPaw](https://macpaw.com/how-to/vsco-filters-free), [Sandmarc](https://sandmarc.com/blogs/creator-tips/best-free-paid-filters-for-vsco)
- Recreating VSCO looks (F2 black values, limits of matching): [Darkroom blog: Recreating VSCO filters](https://darkroom.co/blog/2017-03-recreating-vsco-filters), [Adobe Community thread](https://community.adobe.com/t5/lightroom-ecosystem-cloud-based-discussions/best-ways-of-re-creating-a-vsco-filter/m-p/10834570)
- Usage popularity (M5 and F2 most used, then G3, C1, P5): [DPReview forum](https://www.dpreview.com/forums/post/55608711)
- Film stocks: [PetaPixel: Pro 400H vs Portra 400](https://petapixel.com/2020/08/21/film-photography-shootout-fujifilm-pro-400h-vs-kodak-portra-400/), [Bay Photo: Portra 400 vs Cinestill 400D](https://bayphoto.com/blog/film-comparison-portra-400-vs-cinestill-400d/), [Unique Photo: film stocks for portraits](https://www.uniquephoto.com/photoinsider/best-35mm-film-stocks-for-portraits-color-rendition-skin-tones-grain-and-budget-compared), [FredMiranda forum](https://www.fredmiranda.com/forum/topic/1940872/0)
- Fujifilm simulations: [J.M. Peltier: film simulation differences](https://jmpeltier.com/fujifilm-film-simulation-differences/), [Fuji X Weekly: Classic Chrome recipes](https://fujixweekly.com/2024/03/11/my-15-favorite-film-simulation-recipes-that-use-classic-chrome/), [Classic Negative recipes](https://fujixweekly.com/2024/03/20/my-15-favorite-film-simulation-recipes-that-use-classic-negative/), [Nostalgic Neg recipes](https://fujixweekly.com/2024/03/27/my-5-favorite-film-simulation-recipes-that-use-nostalgic-neg/), [Fuji Rumors: colour science](https://www.fujirumors.com/fujifilm-colors-science-gfx-vs-x-series-from-superia-to-classic-negative-more-film-simulations-part-2/)
- Test photos: stock images from picsum.photos (Unsplash). Used only for testing and not committed.
