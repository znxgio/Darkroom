# Darkroom: overnight changes

Branch: `claude/aesthetic-photo-editor-ndtxt4`. Every phase is its own commit, and the app worked at each one.

**How this was tested:** headless Chromium (Playwright with the SwiftShader WebGL renderer) at iPhone 15 (393×852) and iPhone SE (375×667) sizes, in light and dark mode. The test photos were synthetic (gradient sky, colour blocks, skin-tone disc, grey ramp) because there are no real photos in the container. **Nothing was tested on a real iPhone or in real Safari.** Every "Certain" below means "verified in Chromium". iOS Safari quirks such as memory limits, the share sheet, HEIC files and home-screen mode were not tested.

Confidence tags: **[Certain]** verified by an automated test or screenshot · **[Likely]** code path ran without errors but the result wasn't fully checked, or it depends on iOS behaviour I know but couldn't test · **[Guessing]** unverified.

---

## Structure

- `index.html` is the app. `darkroom.html` now redirects to it, so an existing home-screen icon keeps working. [Certain in Chromium, Likely on an iOS home-screen icon]
- `css/app.css`, plus `js/presets.js` (preset library), `js/gl.js` (WebGL pipeline), `js/util.js` (decoding, EXIF, IndexedDB, stamp and text drawing), `js/app.js` (core), `js/panels.js` (effects, frames, stamp), `js/tools.js` (my presets, batch), `js/edit.js` (adjust, crop, compare, undo, drafts, export) and `js/extras.js` (feed, text, collage, carousel).
- No build step, no CDNs, no network calls. `manifest.webmanifest`, icons and `sw.js` (service worker) are new.
  - Once the app has loaded once over https, it opens offline. [Certain in Chromium: reloaded with the network turned off]
  - The service worker fetches from the network first with a 3-second timeout and falls back to the cache, so new pushes reach the phone on the next launch. [Likely]
- Pipeline: geometry (crop/rotate/flip/straighten) → grade → preset halation → **look** (the old final pass without the border, plus manual adjustments) → **final** (effects, frame, before/after split) → sprites (date stamp, text, film edge text).
- Kept from before:
  - The `[hidden]{display:none!important}` rule
  - The blob URL → data URL → createImageBitmap decoding chain
  - The ~12 MP export cap with smaller retries
  - Press-and-hold for the original
  - Share sheet with long-press fallback

## Phase 1: preset library

- **47 presets in 6 collections** [Certain]:
  - Film (9): TV Set, Golden 400, Portrait 160, Gold 200, Green 400, Vivid 100, Slide 50, Cool 400, Coast Fog
  - Vintage (8): Expired, Faded '70s, Chrome 64, Summer '79, Mall '86, Album, Cross, Bypass
  - Retro camera (8): Disposable, Instant, Instant Cool, Digicam '04, CCD, Flash 35, Super 8, Camcorder
  - Cinematic (8): Sodium, Observer, Blockbuster, Neon Night, 800T, Overcast, Dune, Glasshouse
  - B&W (7): Silver 400, Push 1600, Pearl, Selenium, Sepia, Noir, Ghost
  - Soft (7): Pastel, Dreamy, Haze, Milk, Peach, Lavender, Cotton
- **Your 8 original presets render pixel-identical to the previous version.** I compared every pixel of the preview canvas against the old `darkroom.html` for TV Set, Golden 400, Sodium, Expired and Silver 400: max difference 0. TV Set's values are untouched. [Certain]
- The grade pass gained per-channel curves (for cross-process, faded blues and the B&W filter looks), a tintable halation (white bloom for CCD, Dreamy and Ghost) and colour noise (digicam/CCD). [Certain]
- Every preset gets a live thumbnail of the current photo and the strength slider. [Certain]
- The collections are swipeable tabs above the film strip, and the app remembers the last collection you opened. [Certain]
- **Favorites**: tap the star next to the preset name, or long-press a preset in the strip. Favorites appear in a Favorites tab at the front, and starred presets show a small ★ in the strip. [Certain for the star button. Long-press: Likely, because it wasn't tested with a real finger.]
- **Taste check:** I tuned the presets by eye against synthetic test images, not real portraits or street photos. Some may need adjusting on your R10 files. The likeliest candidates are Slide 50 and Vivid 100 (strong saturation), Push 1600 (heavy grain) and Ghost (a fake infrared look that's very bright). [Likely they look distinct; whether they look tasteful is a guess.]

## Phase 2: effects, stamp, frames, custom presets, batch

- **Effects tab**: 13 stackable effects, each with intensity, plus styles where relevant. They sit on top of the preset, so the preset's strength slider doesn't change them. [Certain each renders, contact sheet checked]
  - Grain: fine, medium or coarse.
  - Dust & scratches: dust, dust + scratches, or scratches. Includes hair fibres.
  - Light leak: 5 colours (warm, rose, gold, cool, rainbow) × 8 positions.
  - Film burn: 4 edges.
  - Halation, Bloom.
  - VHS: scanlines, chroma bleed, tracking band, noise.
  - RGB split: lens or shift.
  - Blur: soft focus, lens (edges), or full.
  - Fisheye: adds to the preset's own fisheye.
  - Prism.
  - Double exposure: choose a second photo, then screen, lighten or multiply.
  - Texture: paper or plastic. Esti has these as "overlays".
  - **Shuffle** re-rolls the random pattern for dust, leaks, burn and VHS. **Off** turns an effect off. Active effects show a dot.
- **Date stamp** (Frame tab): drawn as 7-segment LCD digits with an orange glow, in 3 colours.
  - Defaults to the photo's EXIF DateTimeOriginal in the style `'24 11 2`. Falls back to the file date.
  - Editable text. "Photo date" restores the EXIF date.
  - The digits render [Certain]. **EXIF reading wasn't tested on a real Canon/iPhone file** because the test JPEGs had no EXIF, so the fallback ran [Likely for JPEG; Guessing for HEIC, which uses a byte search for the Exif block]. iOS may also strip EXIF when it hands a photo to Safari, in which case you'll get the file date.
- **Frames**: Preset (TV Set keeps its paper border), None, Thin white, Thick white, Black, Polaroid (thick bottom), Film. The film rebate has sprocket holes on the long edges, amber "DARKROOM 400" text and frame numbers, and works in portrait and landscape. [Certain]
- **My presets**:
  - ⋯ › Save look stores the preset, strength, effects, adjustments, frame and stamp on/colour. Crop and text stay with the photo.
  - Saved looks appear in a "My presets" collection tab with thumbnails, and can be favourited.
  - ⋯ › My presets lets you rename, update with the current edit, move up/down, delete, export JSON (share sheet or download) and import JSON.
  - Stored in localStorage. [Certain for save, list and apply. Likely for import/export, whose code ran but wasn't round-tripped through the iOS Files app.]
- **Batch edit** (⋯ › Batch edit): pick up to 40 photos, then "Develop N", then "Save all N" (one share sheet with every file). [Certain in Chromium with 2 photos]
  - Each photo gets its own EXIF date on the stamp if the stamp is set to automatic.
  - If you chose a crop ratio (e.g. 4:5), each photo is centre-cropped to it.
  - Text layers are not applied in batch.

## Phase 3: fine control and workflow

- **Adjust tab**: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, fade, clarity, sharpen, vignette. [Certain they render; the numbers are my tuning]
  - They apply after the preset mix, so they're on top of everything and independent of strength. Grain from effects comes after them.
  - Double-tap the slider to reset one adjustment, or use "Reset all". [Likely: the double-tap is detected from pointer events and wasn't tested by hand]
- **Crop tab**: Free, Original, 1:1, 4:5, 3:2, 2:3, 16:9, 9:16 [Certain: aspect, handle drag and straighten were tested]
  - Drag the corners or move the box.
  - Rotate 90°, Flip, Straighten ±15° with auto-zoom so no empty corners show, Reset.
  - While you're on the Crop tab the whole photo shows with the box over it. Leaving the tab applies the crop.
- **Before/after**: the split-screen button in the toolbar shows a draggable divider, with the original on the left. Press-and-hold still works too. [Certain the split renders. Likely the drag works by touch.]
- **Undo/redo**: toolbar arrows, up to 80 steps. Cmd/Ctrl+Z works on a keyboard. [Certain]
- **Drafts**: the edit auto-saves to IndexedDB, as does the original photo when it's opened. The start screen then shows "Continue last edit" with a thumbnail. I chose a button instead of auto-restoring, so a photo that crashed Safari can't crash it again on every launch. [Certain in Chromium after a reload]
- **Export options**: Save opens a sheet with Full (≤ ~12 MP), 4K, 2K, or Instagram (exactly 1080 wide), a JPEG quality slider (60–100) and the resulting pixel size. [Certain: blob dimensions checked, e.g. Instagram = 1080 × 985 with the film frame]

## Phase 4: secondary

- **Feed preview** (⋯ › Feed preview): a 3-column grid, 3:4 (the current Instagram profile grid) or square. [Certain]
  - The current edit appears as the dashed "Next" tile, followed by your saved exports, newest first.
  - "Add posts" imports existing posts for context. Tap a tile twice to remove it. Keeps the last 60. Stored in IndexedDB.
- **Text layers** (Text tab): [Certain for add, font, colour and drag with a mouse. Pinch is Likely: two-finger gestures weren't tested.]
  - Fonts: Sans, Serif, Didot, Typewriter, Mono, Futura, Script and Marker, using iOS system fonts with fallbacks. In Chromium on Linux, Didot, Futura, Script and Marker show their fallback fonts.
  - 8 colours, shadow, size and turn sliders.
  - Drag on the photo to move, pinch to resize and turn. Text is re-rendered at full resolution on export.
- **Collage** (⋯ › Collage): 2–9 photos. [Certain in Chromium with 4 photos]
  - Layouts are generated from row/column patterns (4–8 per photo count).
  - Shapes 1:1, 4:5, 9:16, 3:2. Background white, cream or black. Spacing slider. Shuffle.
  - "Apply current look" is on by default.
  - Saves at 2160 px wide.
- **Panoramic carousel** (⋯ › Panoramic carousel): splits the current edit, without its frame, into 2–10 slides of 1080×1350. [Certain in Chromium with 3 slides]
  - Shows a guide with the cut lines and suggests a slide count from the photo's shape.
  - "Save all" sends every slide in one share sheet.

## Skipped or incomplete

- **HSL / colour-specific adjustments, heal, makeup, stickers, AI features and video** (all in Esti) were not built. Most were out of scope, and HSL wasn't on your list.
- **Batch editing doesn't show progress per thumbnail.** It shows "Developing 3 of 10…" in a spinner instead.
- **Custom presets can't be edited in place.** To change one, apply it, change things, then use "Update with current edit" in My presets.
- **The Film frame's edge text is fixed** to "DARKROOM 400" and frame numbers 14/14A…. It isn't editable.
- **Collage cells can't be repositioned individually.** You can only shuffle the order or change the layout.
- **The carousel guide includes the preset's paper border** (it's a snapshot of the preview), but the slides themselves don't.

## Known bugs and risks

1. **iPhone memory at full-size export (risk, not observed).** The pipeline now keeps one more full-resolution buffer than before (the "look" pass), so a 12 MP export peaks around 4× the image in GPU memory, against about 3× before.
   - To offset this, it releases the source canvas after upload, frees the grade buffer once it's used, and drops the source texture after the geometry pass.
   - If iOS reloads the tab during Save, try Save › 4K, or tell me and I'll lower the cap to ~9 MP. [Guessing whether it's a problem]
2. **The share sheet after a long render.** Single saves use the same path as before, which you said worked. Batch, collage and carousel make you tap "Save all" after rendering, which gives iOS a fresh tap so the share sheet should open. [Likely]
3. **`prompt()`/`confirm()` are used** for naming looks and for adding text. They work in Safari, and I believe in home-screen mode too, but they look plain. [Likely]
4. **Long-pressing a preset** might also trigger iOS's text-selection or callout. I suppressed the context menu, but couldn't test a real touch. [Guessing]
5. **Hold-to-compare and the split view** both show the original with your crop applied and no preset, effects or fisheye. Hold-to-compare keeps the frame around it, so the photo doesn't jump in size.
6. The preview resolution doesn't increase after a tight crop, so a heavily cropped photo looks a little soft in the editor. Export is still full resolution.
7. The service worker only registers over https (GitHub Pages) or localhost. Opening `index.html` as a local file works but won't be available offline.

## What to test first on your iPhone

1. **Open a real R10 JPEG and an iPhone HEIC.** Check the photo loads, TV Set looks exactly like before, and the date stamp shows the photo's real date (Frame tab › Date stamp).
2. **Save at Full size** with a heavy look (TV Set + Dust + Light leak + Film frame + stamp). This tests memory and the share sheet. If the tab reloads, note what you were doing.
3. **Browse every collection** and star a few favourites. Tell me which presets look wrong on real photos.
4. **Batch edit 5–10 photos**, tap "Save all", and confirm they all land in Photos.
5. **Crop with your thumb**: corner handles, 4:5, straighten. Then the before/after divider.
6. **Close Safari mid-edit**, reopen, and tap "Continue last edit".
7. **Add to Home Screen** from index.html (or keep the old icon, which redirects). Open it once online, then try it in airplane mode.
