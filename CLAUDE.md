# Darkroom — notes for Claude

This repo is **public**. Never write personal details here (names, emails, account data, coin balances).

Read `docs/claude-notes.md` first. It is the running catalog of how to work with this user, what we learned,
EA Web App facts, bugs and their causes, and open work. **Add to it whenever you learn something**, even
something small, and commit it with your work.

## Quick rules
- "Reply first", "no action taken" or "let's talk about" means discuss only: change nothing, run nothing that writes.
- "Pause", or the user is testing: don't push.
- After every push of `fc-sniper`, wait until the raw install link serves the new `@version`, then send the link:
  https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
- Work on branch `claude/ea-fc-sniping-bot-jdz6vq`. No PR unless asked. No model names in commits or code.
- Safety limits in the bot stay. Don't build detection evasion (undetectable modes, human-like browsing to avoid flags, captcha bypass).
- Anything that spends coins goes through the shared limits (Keep coins, spend limit, session/daily caps, buy-once). Test it.
- Unsure about a design or decision? Run a debate first (protocol in docs/claude-notes.md §8). If the debate makes you
  confident, build and push; if it's a judgment call for the user (money risk, account-visible behavior), ask first.
- Model routing: Opus leads; big-brother advisors and the Sonnet intern per `~/.claude/CLAUDE.md`.

## Projects
- `fc-sniper/` — EA FC 27 Web App userscript (sniper, trade bot, SBCs, packs, squad tools). See its README.
- `darkroom.html` — a film-preset photo editor (single page). Not touched so far.
