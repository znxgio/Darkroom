# Darkroom coach: working notes

Read this first in any new session. This is a separate app from `accountability/`, kept in its own folder.

## How the owner likes to work
- They're not a developer, so explain plainly. Recommend one option instead of listing choices.
- Ask before anything that costs money. Free tiers are OK. Say when something will start costing money.
- The repo is PUBLIC. Never commit secrets, emails, personal data or photos. No AI model names in commits.
- Test before every push: `npm test`, `npm run test:sql`, `npm run build && npm run e2e`.

## What they shoot
Candid and everyday photos: friends, city scenes, lights, venues, raves and concerts. iPhone only.

## Stack and why
- **React + TypeScript + Vite**, a static PWA hosted on Vercel (free). It's the same stack as `accountability/`, so one person can maintain both.
- **Supabase** (free): login, Postgres, and the `critique` Edge Function that holds the API key.
  - Plan: a separate free project "Darkroom" (the owner's first project is "Daily").
  - Not created yet; that waits for the owner's go.
- **Login: email + password.** A magic link opens in Safari, not the Home Screen app.
- **Demo mode**: with no Supabase env vars, the app uses `src/data/memoryRepo.ts`. Data stays in the browser and critiques are canned (free, but they "cost" $0.035 so the cap can be tested).
- **On-device detection**: MediaPipe Tasks Vision (`@mediapipe/tasks-vision`).
  - Models: pose (people + head/knee/ankle points), face, and EfficientDet-Lite0 objects. They run in turns, one per ~120ms tick.
  - The engine's .wasm file is copied from node_modules into `public/mediapipe` at build time (git-ignored).
  - The models load from storage.googleapis.com and are cached by the service worker.
  - When upgrading MediaPipe, bump `MODELS` in `public/sw.js` so phones drop the old wasm.
  - It tries GPU first and falls back to CPU.
- **AI**: three paid tiers plus Free (see `TIERS` in `supabase/functions/_shared/critique.ts`), on the beta Messages endpoint.
  - The owner asked for this on 2026-11-17 after learning the API isn't covered by their Claude subscription.
  - Cheap (cheapest model, ~0.1¢) is the default. Better (mid-tier, ~2¢) and Best (top model, ~3–4¢) are also available.
  - The cheapest model has no server-side fallback, so it's sent without `fallbacks`.
  - Structured JSON output (`output_config.format`), effort `low` (Quick) or `medium` (Thorough).
  - Server-side refusal fallback (`fallbacks: "default"`). When a fallback model runs, cost is charged at the pricier model.
  - Pinned SDK `npm:@anthropic-ai/sdk@1.8.0` (Deno blocks packages less than 24h old).
- **Photo sent to the AI**: a 1600px JPEG copy. Newer models accept a long edge up to 2,576px, but 1600px keeps the image at about 2.5k tokens (≈1¢).

## Decisions
- **Full-res photos never leave the phone**, except the 1600px copy sent once to the AI. That copy is not stored by us.
- **Thumbnails** (360px JPEG, about 15–30 KB) are stored as data URLs in `photos.thumb`, protected by row security. This is simpler than a storage bucket, and the database is private per user.
- **Spending cap**: the server keeps a ledger in `api_usage` that the app can only read. The cap check refuses a critique when `spent + worst case (≈14¢) > cap`, so the cap is never passed. The month resets at midnight LA time on the 1st.
- **Critiques and spending can only be written by the server function.** The app can't fake a score or hide spending; SQL tests prove this.
- **Save to camera roll**: via the share sheet (`navigator.share({files})` → "Save Image"), called straight from the tap. If sharing isn't available, the app says to press and hold the image → "Save to Photos".
  - I couldn't find a source confirming "Save Image" from a Home Screen web app specifically. Verify on the phone.
- **Low-light rule**: when average brightness stays under 0.13 for 1.5s, a card says to use the iPhone Camera app (Night mode) and import the photo. It works even with coaching off.
- **Tilt**: computed from the gravity vector. The roll is folded to the nearest 90°, so iOS/Android sign conventions and landscape don't matter. The nudge text has no direction arrow; the on-screen level line shows which way to turn.
- **Re-critique**: only the thumbnail is kept, so "Critique again" asks you to pick the full photo from the camera roll again. The new critique attaches to the same gallery photo.
- **Recurring habits**: each critique has 0–3 issue tags from a fixed list (`supabase/functions/_shared/critique.ts`). The function tells the AI the person's top recurring habits so it can follow up. The Progress tab shows the habits, a "this week's focus" tip, the trend and the subscores.
- **Linking to other apps later**: the SQL function `practice_summary(days)` returns photos, critiques, average score and last photo time for the signed-in user. Another app (e.g. the habit tracker) could call it later. Nothing links yet.

- **Free mode (Claude app)**: the app copies a coaching prompt; you share the photo into your Claude app, paste the prompt, then copy Claude's reply back.
  - The reply ends with a `DARKROOM-DATA` line plus JSON. `parseChatReply` reads it, tolerating code fences, braces inside strings and curly quotes.
  - The app saves it itself. A row-security policy allows only `model = 'claude-app'`, `cost_usd = 0`, no ledger link, and only on your own photo. Paid critiques stay server-only.
  - Free mode needs no API key at all.
  - Unverified: whether the Claude iOS app appears in the share sheet for images. The steps include a fallback (attach the photo from the camera roll inside the Claude app).
- **Cap check is per tier**: `worstCaseUsd(tier)` is priced at the tier's model or its fallback, whichever costs more. When Best is blocked, Cheap and Free usually still work, and the cap error offers "Ask in Claude app (free)".

## Data model
- `photos`: thumb, source (import/live), size, EXIF camera info (never GPS), live score at capture, note
- `critiques`: score, result JSON, tags, cost (written by the server only)
- `api_usage`: the spending ledger (written by the server only; kept even if a photo is deleted)
- `settings`: modes, editing tips, cap, depth, default critic (`model_tier`: free/cheap/better/best), overlay defaults

## Deploy checklist
- Deploy `critique` with verify_jwt OFF (Management API: `verify_jwt: false`).
- Function secrets: `ANTHROPIC_API_KEY` (the owner pastes it), `ALLOWED_ORIGIN` (the Vercel URL).
- The function uses SUPABASE_SERVICE_ROLE_KEY, falling back to SUPABASE_SECRET_KEYS.
- Smoke test:
  - sign in → import a photo → Get critique → the cost shows in Settings
  - set the cap to $0.10 → the next critique is refused

## Bugs and causes
- `monthStartLA` compared the hour to "0", but Intl printed "00", so the cap would have reset an hour late in PDT. Caught by a unit test.
- Settings used to save after a 400ms delay, so raising the cap and critiquing right away still hit the old cap. Now they save immediately, in order.
- `.setting > div` styles also hit the segmented control (`.seg`), which stacked its buttons. Scoped to `:first-child`.

## Open to-dos
- Owner: decide on going live (Supabase project and Vercel; an Anthropic key only for paid tiers). Steps are in README.md.
- Verify on the iPhone:
  - share sheet "Save Image" from the Home Screen app
  - the motion permission prompt
  - MediaPipe speed on the phone (if slow, drop the face model or lengthen TICK_MS)
- Ideas not built yet:
  - apply the film presets from `../darkroom.html` to a shot
  - a "photo walk" mode with one assignment per outing (e.g. "only shoot reflections")
  - compare two shots of the same scene
