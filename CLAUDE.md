# CLAUDE.md for ai-systems-api-gateway

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../../docs/CLAUDE.md`).

## Commands

| Command          | Does                                            |
| ---------------- | ----------------------------------------------- |
| `npm ci`         | install from the lock file                      |
| `npm start`      | `node src/main.ts` (type stripping, no build)   |
| `npm run check`  | `tsc --noEmit` (TypeScript 7)                   |
| `npm run lint`   | ESLint (strict type-checked) and Prettier check |
| `npm test`       | `node --test` with the coverage gate: 70% lines |
| `npm run verify` | check, lint and test                            |

No integration tests: the service has no database and no NATS. The tests
start a local JWKS and fake upstream servers in the process.

## Layout

```
src/main.ts        env, telemetry, logger, verifier, listen (not in the tests)
src/env.ts         env schema
src/app.ts         routes, upstream calls, problem pass-through
src/rate-limit.ts  token bucket for each subject (a before hook)
```

This service has no domain code. It checks the caller and the input, and
forwards to the services.

## Rules

- Every `/api` route is behind `bearerHook` (kit/auth). Do not add a route
  outside `/api` except the kit `/health`, `/ready` and `/metrics`.
- Every upstream call has a timeout, sends `x-correlation-id`, and its
  answer is checked with zod. A bad answer is 502, no answer is 503.
- The kit and contracts come from git tags. Update the `allowScripts`
  entries with the commit of the new tag (`npm install-scripts approve`).

## TypeScript 6 and 7

Same as the kit: `typescript` is TypeScript 6 for ESLint only,
`typescript-7` is for `check`. Never run `npx tsc`. ADR 0022.
