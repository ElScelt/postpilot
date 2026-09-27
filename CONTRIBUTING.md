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
```

- `npm run test:coverage` prints a coverage report.
- `npm run build` checks the production build.

## Pull requests

- Keep each pull request to one change, and explain in the description why it is needed.
- Add or update tests for any behaviour you change. Tests use `node:test` and fake every external service through injected parameters; they must never touch the network.
- Match the surrounding code: small modules, no new dependencies or abstractions unless they remove real duplication, and comments that explain *why*.
- If you change a validator rule or prompt wording, run `npm run draft -- --offline` and, if you can, a few live `npm run draft` runs. Say in the pull request what you saw.
- New configuration belongs in `postpilot.config.ts` (with a default, a schema entry and a row in the README's table), never in environment variables. Environment variables are for secrets and infrastructure.
- Update `CHANGELOG.md` under an "Unreleased" heading.
- Never commit secrets or real `.env` files. See [SECURITY.md](SECURITY.md).
