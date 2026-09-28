# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- CI also runs `npm run build`, and its actions are pinned to commit SHAs.

### Fixed

- A Reject that fails, for example because Redis is unreachable, answers 500 with a "Reject failed, try again" page instead of claiming the post was already handled. Only a post that is no longer queued gets "Nothing to do", and the page names its state.
- Redis credentials are read from `KV_REST_API_URL` and `KV_REST_API_TOKEN`, the names the Vercel marketplace integration adds, as well as from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. A marketplace setup used to fail the Setup card and every run.
- The test suite runs on the default configuration, so a customised `postpilot.config.ts` no longer fails tests that expect UTC or an empty stack; one test still validates the file itself.

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
- Draft checks added after the first live test:
  - the validator rejects missing full stops, run-together compounds ("adhoc", "a trade off") and present-tense claims about the author's own systems ("our component library renders"), and tells a short draft how many words to add;
  - a strict-JSON answer that nests its paragraphs is unwrapped instead of discarded, and any other malformed answer gets a correction naming what was wrong;
  - the review pass drops a cited source that reports a different story, and declines the post when the remaining sources cannot clear the evidence bar;
  - account, sign-in and status portals under a vendor domain (such as `myaccount.microsoft.com`) never count as sources.

[Unreleased]: https://github.com/ElScelt/postpilot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ElScelt/postpilot/releases/tag/v1.0.0
