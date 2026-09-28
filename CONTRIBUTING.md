# Contributing

Thanks for helping. Bug reports, fixes and focused improvements are welcome. For anything larger than a small fix, please open an issue first so we can agree on the approach before you write the code.

## Setup

You need Node.js 22.9 or newer (`.nvmrc` pins 22).

```bash
npm ci
npm run draft -- --offline
```

The offline draft runs the full drafting pipeline on canned data and needs no keys. To work against real services, copy `.env.example` to `.env.local` and fill in what you need: `GROQ_API_KEY` and `TAVILY_API_KEY` are enough for `npm run draft`, and the full list is needed for `npm run dev`.

## Checks

CI runs all of these on every push and pull request, and they must pass:

```bash
npm run lint
npm run typecheck
npm test
npm run draft -- --offline
npm run build
npm audit --omit=dev --audit-level=high
```

`npm run lint` uses type information, so an unawaited promise or a switch that misses a case fails it; mark a promise you mean to leave running with `void`.

`npm run test:redis` runs the Redis scripts (the run lock, the post store's compare-and-set) against a real Redis, one file at a time, because some of the files write the real `postpilot:*` keys. CI starts a Redis for it; locally, start Redis and Upstash's REST emulator first:

```bash
docker network create postpilot-test
docker run -d --name postpilot-redis --network postpilot-test redis:7.4-alpine
docker run -d --network postpilot-test -p 8079:80 -e SRH_MODE=env -e SRH_TOKEN=postpilot-test -e SRH_CONNECTION_STRING=redis://postpilot-redis:6379 hiett/serverless-redis-http:0.0.10
```

`npm run build` is the only check that validates what route files export, so run it before pushing a change under `src/app`.

`npm run test:coverage` runs the same tests and prints a coverage report. CI runs it and fails when lines, branches or functions drop below the floor set in `package.json`, which sits a little under what the suite measures today. Node counts only the files a test loads, so the floor says nothing about the dashboard's `page.tsx`, `forms.tsx` and `actions.ts`: they need the Next runtime, and `npm run build` plus the tests of what they call are what check them. `actions.ts` only hands the request to `action-handlers.ts`, which is tested. If a change lowers coverage, add tests rather than the floor.

## Pull requests

Every change reaches `main` through a pull request, and `check` and `redis` must pass before it merges. Pull requests are squash-merged, so the title becomes the commit message. Write it as a [Conventional Commit](https://www.conventionalcommits.org/): a type, an optional scope, and a short lowercase summary, such as `fix(publish): never retry an unknown outcome` or `docs: explain the evidence bar`.

- Keep each pull request to one change, and explain in the description why it is needed.
- Add or update tests for any behaviour you change. Tests use `node:test` and fake every external service through injected parameters; they must never touch the network.
- Match the surrounding code: small modules, no new dependencies or abstractions unless they remove real duplication, and comments that explain *why*.
- If you change a validator rule or prompt wording, run `npm run draft -- --offline` and, if you can, a few live `npm run draft` runs. Say in the pull request what you saw.
- New configuration belongs in `postpilot.config.ts` (with a default, a schema entry and a row in the README's table), never in environment variables. Environment variables are for secrets and infrastructure.
- Update `CHANGELOG.md` under an "Unreleased" heading.
- Never commit secrets or real `.env` files. See [SECURITY.md](SECURITY.md).
