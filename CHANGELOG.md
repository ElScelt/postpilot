# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.1] - 2026-09-28

### Changed

- A run stopped by a missing or expired LinkedIn authorization has a status of its own, `stopped`, and reports a failure to the healthcheck instead of a healthy night. A crash reports a failure only on QStash's last retry, so a failure that will be retried no longer pages you. The README now suggests a 45-minute grace period for the check, since the last retry comes about half an hour after the first delivery.
- The dashboard's Reject and Edit word a refusal like the review page: **Too late** once the publish has started, **Nothing to do** for a post already handled or gone. A Reject of a post that is being published now says **Too late** on the review page too.
- The LinkedIn client is split into its token store (`src/lib/linkedin/token.ts`) and its publisher (`src/lib/linkedin/publish.ts`). Shared limits live in `src/lib/limits.ts`, and queueing a post's publish message moved out of the post store into `src/lib/queue-post.ts`.
- Retries and reconnect links are decided by error type rather than by matching error text.
- The draft prompt reads its theme briefs and the allowed theme ids from the settings it is given, like the rest of the prompt.
- The validator is one ordered table of checks, and the patterns for invented experience and history have a module of their own.
- Linting uses type information and fails on an unawaited promise or a switch that misses a case.

### Fixed

- A post is never published unless its review notice arrived. If ntfy cannot be reached, the run fails and QStash retries it, sending the notice again; on the last retry the post is withdrawn instead of publishing unreviewed.
- A run that stored the night's post but crashed before queueing its publish message or sending its notice finishes that post on QStash's retry. Before, the retry saw the post, skipped the night, and the post either never published or published without a notice.
- Every QStash call, from the run, the schedule check and the dashboard's Run now, gives up after 10 seconds. The QStash client takes no abort signal, and a hung call ran until the platform killed the function.
- When LinkedIn accepted a post and the first write of its record landed but its answer was lost, the retry found the post already `posted` and raised a false "record was not updated" alert.
- The run history is written with the same compare-and-set as the post queue, so a crash recorded after the run lock is released can no longer overwrite another run's record.
- The Redis test files run one at a time. Two of them write `postpilot:posts`, and running them in parallel made CI fail at random.

## [1.1.0] - 2026-09-28

### Added

- `npm run check:data` checks, read-only, whether this version can read a deployment's post queue, run history and LinkedIn authorization.

### Changed

- CI fails when test coverage drops below a floor, and the dashboard proxy, the LinkedIn connect and callback routes and every route file's exports have tests.
- The test suite pins the default configuration through a function instead of the `POSTPILOT_CONFIG` environment variable, which a deployment could have set by accident.
- CI also runs `npm run build`, and its actions are pinned to commit SHAs.

### Fixed

- Posts, runs and the LinkedIn authorization are checked as they are read from Redis. A queue holding a post this version cannot read stops with an error that names the field, instead of failing in some later step or being rewritten without it.
- An environment variable left blank counts as unset, and whitespace around a value is ignored. A blank `NTFY_URL` used to send alerts to a relative URL, and a blank `GROQ_MODEL` stopped every run.
- The review page shows a failure page with the Reject button when it cannot load the draft, instead of a blank error.
- The evening sweep retires a post that a killed delivery left mid-publish, with an alert to check LinkedIn, instead of leaving it stuck. It is never retried.
- The publish route claims a post before calling LinkedIn, so a Reject that arrives mid-publish says it is too late instead of reporting success and being overwritten. A LinkedIn call that times out or fails in a way that may have saved the post is never retried; you get an alert to check LinkedIn. Before, a hung LinkedIn call left the post queued and QStash's retry could post it twice.
- When LinkedIn accepts a post but its record cannot be written, the write is retried once and the alert names the LinkedIn post id.
- Every write to the post queue is a compare-and-set, so concurrent writers no longer undo each other: a dashboard edit, a Reject and the publish route used to be able to write back stale copies of the whole queue.
- The drafting deadline is derived from the run route's time limit, and every Tavily and Groq request, as well as every wait on Groq's rate limit, ends at it. One slow call used to be able to carry the run past the limit, where it was killed without a record.
- Calls to ntfy, healthchecks.io, Tavily, Groq, Redis and LinkedIn's sign-in endpoints time out instead of waiting until the platform kills the function.
- A QStash delivery that finds another run in progress answers 503, so QStash retries it, instead of recording a skip and pinging the heartbeat as healthy. The last retry alerts. Before, a killed run's retries all ended as a silent skip and the night was lost with no alert.
- The run lock expires after the run route's 300-second limit instead of ten minutes, and holds a per-run token that only its own run can release. A run killed at the limit used to hold the lock through QStash's retries.
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

[Unreleased]: https://github.com/ElScelt/postpilot/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/ElScelt/postpilot/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/ElScelt/postpilot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ElScelt/postpilot/releases/tag/v1.0.0
