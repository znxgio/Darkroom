# Darkroom: photo coach

A personal photography coach for candid iPhone photos. It's an installable web app (PWA) with two modes:

- **Live coaching**: an in-app camera with a thirds grid, a level line and a center guide. On-device detection gives nudges like "tilt down" or "cutting off feet", plus a live 1–10 score. When the scene is too dark, it tells you to switch to the iPhone Camera app (Night mode) and import the photo instead.
- **AI critique**: you get a score, what works, what to fix, angle tips and optional editing tips. A monthly spending cap stops critiques once you reach it.

Full-size photos stay in your camera roll. The cloud only keeps small previews, critique text and the spending ledger.

## Run it locally (demo mode, free)

```
npm install
npm run dev        # http://localhost:5173: demo mode, sample critiques
npm test           # unit tests
npm run test:sql   # database privacy tests (needs local Postgres)
npm run build && npm run e2e   # phone-width browser check
```

## Going live: what the owner does

These steps are one-time. Steps 1 and 3 are free; step 2 costs money.

1. **Supabase (free).** Say "go" and Claude creates a second free project called "Darkroom" next to "Daily". The free plan allows 2 active projects. Claude then sets up the database and the critique function.
2. **Claude API key (paid, pay-as-you-go).**
   1. Go to console.anthropic.com, then Billing, and add credits. A $5 minimum is typical.
   2. Under Limits, set a monthly spend limit, for example $10. This is a second safety net on top of the cap in the app.
   3. Create an API key.
   4. Paste it in Supabase → Edge Functions → Secrets as `ANTHROPIC_API_KEY`. Claude never sees it.
3. **Vercel (free).**
   1. Add a new project from this repo with **Root Directory** `coach`.
   2. Set the env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Claude gives you both values).
4. **Your login.** In Supabase, go to Authentication → Users → Add user, enter your email and a password, and tick "auto confirm". Then Claude turns off sign-ups.
5. **iPhone.**
   1. Open the Vercel URL in Safari.
   2. Tap Share → Add to Home Screen.
   3. Open the app from the icon and sign in.
   4. Tap Start camera, then Allow for both the camera and Motion (Motion is for the level line).

## What Claude does after step 1
- Apply `supabase/migrations/*.sql`.
- Deploy `supabase/functions/critique` with **verify_jwt off**: the function checks the login itself.
- Set the function secret `ALLOWED_ORIGIN` to the Vercel URL.
- Turn off sign-ups once the owner's user exists.

## Cost
- Each critique uses the model named in `MODEL` in `supabase/functions/critique/index.ts`, priced at $4 per million input tokens and $20 per million output.
- The photo goes in as a 1600px copy, about 2,500 tokens, so roughly 1¢ of input.
- Output is about 1–2k tokens, roughly 2–4¢.
- A typical **Quick** critique costs **about 2–4¢**. **Thorough** costs about 2×.
- The server refuses a critique if the next one *could* push you over your monthly cap. One critique can never cost more than ~14¢ (6,000 output tokens max).
- Supabase, Vercel and the on-device detection are free.
