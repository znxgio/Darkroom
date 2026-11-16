# Daily: a personal checklist + accountability app

A Home Screen web app for iPhone. See `NOTES.md` for decisions and status.

## Run locally (demo mode, no accounts needed)
```
npm install
npm run dev
```

## Tests
```
npm test             # logic tests
npm run test:sql     # database rules on a throwaway local Postgres
npm run build && npm run e2e   # phone-width browser check
```

## One-time setup

### What the owner does (about 10 minutes, all free)
1. **Supabase**: sign up at supabase.com and create a project (region West US). Save the database password somewhere safe.
2. **Supabase access token**: Account → Access Tokens → Generate. Don't paste it in chat. Claude asks for it through a secure form (`request_credential`, host `api.supabase.com`), then runs the setup below.
3. **Vercel**: sign up with GitHub at vercel.com, import this repo, set Root Directory to `accountability`.
4. **iPhone**:
   - open the Vercel URL in Safari → Share → Add to Home Screen
   - open the app from the icon and sign in
   - Settings → Turn on reminders

### What Claude does with the access token (Supabase Management API)
1. Run `supabase/migrations/*.sql` in order.
2. Create the owner's login user (email + password; the owner types the password in the app), then turn off sign-ups.
3. Generate VAPID keys and set the function secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, plus PHOTO_ACCESS_KEY if wanted.
4. Deploy the `tick` and `photo-access` functions (`verify_jwt = false`; each checks its own secret or token).
5. Run `supabase/setup/cron.sql` with real values. Never commit the filled-in copy.
6. Give the owner the 3 Vercel env vars to paste: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_VAPID_PUBLIC_KEY. All three are public by design.

### Stakes email (optional, off by default)
Needs a free email-sending account. Recommended: Brevo (free tier; verify a sender address, no domain needed). Then set the secrets EMAIL_PROVIDER=brevo, EMAIL_API_KEY and EMAIL_FROM.
