# Darkroom

A film-style photo editor for iPhone Safari, inspired by Esti. Quick film looks first, fine control second. It runs entirely in the browser with WebGL. There's no build step and no network dependencies, and it works offline once loaded.

## Open it

- **On GitHub Pages:** go to `https://<user>.github.io/<repo>/` (or `index.html`). The old `darkroom.html` link redirects there.
- **On iPhone:** open the link in Safari, then tap Share › Add to Home Screen. Open it once while online so it caches for offline use.
- **Locally:** run `python3 -m http.server` in this folder and open `http://localhost:8000`. Opening `index.html` as a file also works, but without offline support.

## Features

- **47 film presets** in collections: Film, Vintage, Retro camera, Cinematic, B&W and Soft. Each has live thumbnails and a strength slider. Star presets to add them to **Favorites**.
- **Effects** you can stack on any preset:
  - Grain, dust & scratches, light leaks, film burn
  - Halation, bloom, VHS, RGB split, blur/soft focus, fisheye, prism
  - Double exposure with a second photo
  - Paper/plastic texture
- **Retro orange date stamp** from the photo's EXIF date, and editable.
- **Frames:** thin/thick white, black, Polaroid, and film rebate with sprocket holes.
- **Adjust:** exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, fade, clarity, sharpen, vignette.
- **Crop:** aspect ratios, rotate, flip and straighten.
- **Before/after:** split view, plus press-and-hold for the original. Undo/redo.
- **My presets:** save your own looks, then rename, reorder or delete them, and back them up to JSON.
- **Batch edit:** develop many photos with one look and save them all at once.
- **Drafts** auto-save, so closing Safari doesn't lose your edit.
- **Export:** Full (~12 MP max), 4K, 2K or Instagram 1080, with a JPEG quality setting.
- **Text layers, feed preview grid, collage maker (2–9 photos) and panoramic carousel** (seamless 4:5 slides).

See [CHANGES.md](CHANGES.md) for details, known issues and what to test.
