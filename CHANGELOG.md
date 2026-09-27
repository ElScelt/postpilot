# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-28

First public release.

### Added

- Scheduled research and drafting of grounded LinkedIn posts:
  - Tavily search on rotating themes, with dated source tiers;
  - a Groq `gpt-oss-120b` draft with strict JSON output;
  - a validator with one corrected attempt;
  - a review pass against the evidence.
- Delayed publishing through QStash, with a one-tap Reject from an ntfy notification and a read-only review page.
- ntfy alerts:
  - skipped nights;
  - failed runs;
  - publish failures;
  - posts that never went out;
  - expiring LinkedIn authorization.
- An optional healthchecks.io heartbeat.
- A dashboard behind Basic auth:
  - a setup check;
  - authorization status and the next run;
  - post and run history;
  - Run now, Reject and Edit.
- `postpilot.config.ts`: typed, validated configuration for time zone, publish hour, schedule, persona, word and hook limits, source window and themes, with documented defaults.
- `npm run draft -- --offline` to run the drafting pipeline on canned data, with no keys or network.
- Every named resource uses the `postpilot` prefix:
  - Redis keys (`postpilot:token`, `postpilot:posts`, `postpilot:runs`, `postpilot:run-lock:<date>`);
  - the QStash schedule id (`postpilot-run`) and message labels;
  - the OAuth state cookie.
