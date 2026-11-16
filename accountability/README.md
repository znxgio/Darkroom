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

## One-time setup (owner)
### Supabase (free)
1. Create a project at supabase.com. Region: West US.
2. Open SQL Editor and run each file in `supabase/migrations/`, in order.
3. Go to Authentication → Users → Add user. Enter your email and a password, and tick "Auto confirm".
4. Go to Authentication → Sign In / Providers and turn **off** "Allow new users to sign up".
5. Go to Project Settings → API keys. Copy the Project URL and the publishable (anon) key. That key is safe in the browser because Row Level Security protects the data, but it still goes only in Vercel settings, never in git.

### Vercel (free)
1. Import the GitHub repo. Set Root Directory to `accountability`. Framework: Vite.
2. Add environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. In Settings → Environments, set the production branch to the working branch until it's merged to `main`.

### iPhone
1. Open the Vercel URL in **Safari**.
2. Tap Share → Add to Home Screen.
3. Open the app from the Home Screen icon and sign in.
