# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting).

Include what you found, how to reproduce it and what an attacker could do with it. You should get an answer within a week. Once a fix ships, you'll be credited in the changelog unless you prefer not to be.

Only the latest release is supported.

## Scope

In scope:

- authentication: dashboard Basic auth, the QStash signature and bearer checks on `/api/automation/run` and `/api/cron/publish`, and the OAuth state;
- reject links and the review page;
- anything that could let someone other than the owner publish, edit or read drafts beyond what the ntfy topic already exposes;
- secrets leaking into responses, logs, notifications or the dashboard.

Out of scope:

- vulnerabilities in LinkedIn, Vercel, Upstash, Groq, Tavily or ntfy themselves;
- a leaked `NTFY_TOPIC`. By design it lets the holder read and reject drafts, but never edit or publish them.

## Never commit secrets

- Keep secrets in Vercel environment variables and, for local runs, in `.env.local`. Every `.env*` file except `.env.example` is git-ignored, and `.env.example` holds placeholders only.
- Never paste tokens, client secrets, signing keys or your ntfy topic into issues, pull requests, screenshots or logs.
- If a secret does leak, rotate it at its source:
  - regenerate the LinkedIn client secret;
  - roll the QStash signing keys and token;
  - reset the Redis token;
  - create new Groq and Tavily keys;
  - choose a new `AUTOMATION_SECRET`, `LINKEDIN_STATE_SECRET` and `NTFY_TOPIC`.

  Then redeploy. Removing a secret from git history does not revoke it. A new `AUTOMATION_SECRET` also invalidates the Reject links already sent: they answer with an error and cancel nothing, so reject a queued post from the dashboard instead.
- Before committing, a scan such as `gitleaks git` catches most accidents.
