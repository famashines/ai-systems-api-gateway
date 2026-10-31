# ai-systems-api-gateway

HTTP API gateway of ai-systems. Traefik sends `/api` on `ai.famashines.com`
to it (ADR 0011, ADR 0021). It checks the Keycloak token and forwards
commands and queries to the services. It has no database and no NATS.

```
app --HTTPS /api--> Traefik --> api-gateway
                                  | bearerHook (kit/auth): 401, 403
                                  | rate limit for each subject: 429
                                  | zod checks: 400
                                  +--POST--> orchestration /internal/commands/submit-task
                                  +--GET---> projections   /internal/tasks
```

## Routes

| Route                                       | Does                                        |
| ------------------------------------------- | ------------------------------------------- |
| `GET /health`, `GET /ready`, `GET /metrics` | kit probes and Prometheus metrics, no token |
| `POST /api/tasks`                           | submit a task (below)                       |
| `GET /api/tasks?limit=&before=`             | the task list (below)                       |

All other paths need a valid token too: with no valid token, an unknown
path gives 401, not 404 (the hooks run before routing).

### Auth

kit/auth `createJwtVerifier` with `OIDC_ISSUER`, `OIDC_AUDIENCE` and
`REQUIRED_ROLE`. The keys come from `<OIDC_ISSUER>/protocol/openid-connect/certs`.

| Case                               | Answer                                             |
| ---------------------------------- | -------------------------------------------------- |
| no `Authorization: Bearer <token>` | 401, `WWW-Authenticate: Bearer realm="ai-systems"` |
| bad, expired or foreign token      | 401, `error="invalid_token"`                       |
| no `owner` realm role              | 403, `error="insufficient_scope"`                  |
| Keycloak keys not available        | 503 `unavailable`                                  |

### `POST /api/tasks`

Request:

- Header `Idempotency-Key`: a lower-case UUID v4 (ADR 0022), else 400
  `validation_failed` with the path `headers.idempotency-key`.
- Body: `SubmitTaskCommandPayloadV1` (`{ text, mode? }`, `mode` is
  `approval` by default), else 400. Body limit 256 KiB.

The gateway sends this `CommandEnvelopeV1` to
`POST <ORCHESTRATION_URL>/internal/commands/submit-task`:

```json
{
  "commandId": "<Idempotency-Key>",
  "type": "orchestration.SubmitTask",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "text": "...", "mode": "approval" }
}
```

| Orchestration answer                        | Gateway answer                                  |
| ------------------------------------------- | ----------------------------------------------- |
| 201 or 200 with `{ taskId, version }`       | 202, same body, `Location: /api/tasks/<taskId>` |
| problem JSON with 400, 409, 413, 415 or 422 | same status and problem (allowed fields only)   |
| other answer (also 401, 403, 500, 503)      | 502 `unavailable`, generic detail               |
| answer larger than 1 MiB                    | 502 `unavailable`                               |
| no answer in 5 s, or a network error        | 503 `unavailable`                               |

A problem that passes through keeps only `type`, `title`, `status`,
`code`, `detail` and `errors`; `instance` is the gateway path. Other
upstream fields (for example a stack or an internal URL) never reach the
client. The gateway logs the status of a refused answer at warn.

The same key again gives the same task: orchestration stores the
`commandId` with its answer and replays it (200).

`Location` is the URL of the task for later. `GET /api/tasks/<taskId>`
does not exist in M1 (it gives 404); use `GET /api/tasks` or the
WebSocket topic.

### `GET /api/tasks`

- Query, all optional: `limit` (1 to 100), `before` (contracts
  `Timestamp`, ISO 8601 UTC) and `beforeId` (contracts `Id`, lower-case
  UUID v4, for tasks with the same time). Else 400. Other query keys are
  dropped.
- Forwards to `GET <PROJECTIONS_URL>/internal/tasks` and gives
  `TaskListResultV1`. The answer is checked with zod; a bad answer is 502.
  Problem JSON passes through as above.

### Rate limit

A token bucket for each `sub`: 20 requests each second, burst 40. Over
the limit: 429 `rate_limited` with `Retry-After` in seconds. The bucket is
in the process memory: each pod has its own.

### Correlation id

The kit takes `x-correlation-id` from the request if it is a lower-case
UUID v4, else it uses the request id. The gateway sends it to the upstream
services as `x-correlation-id`. OpenTelemetry sends `traceparent`.

## Config

Read once at start with zod (kit/config); a bad value stops the process.
`.env.example` has the names, with no values.

| Variable                                                            | Default                                         |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| `ORCHESTRATION_URL`                                                 | required, `http` or `https` origin              |
| `PROJECTIONS_URL`                                                   | required, `http` or `https` origin              |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems` |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                |
| `REQUIRED_ROLE`                                                     | `owner`                                         |
| `PORT`                                                              | `8080`                                          |
| `LOG_LEVEL`                                                         | `info`                                          |
| `RELEASE`                                                           | `local`                                         |
| `SERVICE_NAME`                                                      | `ai-systems-api-gateway`                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none: no trace export                           |
| `OTEL_RESOURCE_ATTRIBUTES`                                          | none                                            |

The upstream path replaces the path of the URL, so give an origin only,
for example `http://ai-systems-orchestration:8080`.

## Run

```sh
npm ci
ORCHESTRATION_URL=http://localhost:8081 PROJECTIONS_URL=http://localhost:8082 npm start
```

Image:

```sh
docker build --build-arg RELEASE=local -t ai-systems-api-gateway .
docker run --read-only -p 8080:8080 \
  -e ORCHESTRATION_URL=... -e PROJECTIONS_URL=... ai-systems-api-gateway
```

The image runs `node src/main.ts` with type stripping (no build step) as
uid 1000 on `node:26.13.0-slim` (pinned by digest). It writes no files,
so the root file system can be read-only. The build stage uses the full
`node` image, because npm needs git for the kit and contracts. It installs
with `--omit=dev --omit=optional`, so no dev or optional peer packages
are in the image. The runtime stage has no npm and no npx. `node` is the
`ENTRYPOINT` and PID 1: a SIGTERM or SIGINT before the server listens
exits with 143 at once; after that, the kit shutdown handles it.

Release: when `ci` passes on a push to `main`, `.github/workflows/release.yml`
builds the image of that commit, makes a CycloneDX SBOM (a workflow
artifact), and scans the image with grype. A HIGH or CRITICAL finding that
has a fix stops the release. Findings with no fix do not stop it; they are
in the job log. Then it pushes `ghcr.io/famashines/ai-systems-api-gateway:sha-<commit>`
and opens or updates the pull request from the branch
`release/ai-systems-api-gateway-prod` in `famashines/gitops`. That pull request sets the
tag and the digest in `kubernetes/ai-systems/ai-systems-api-gateway/prod`. The owner
merges it. The job needs the org secret `GITOPS_TOKEN` with access to this
repo. A manual run (`workflow_dispatch`) works only on `main`.

## Known limits

- The rate limit map has one entry for each `sub` with the owner role, so
  its size is the number of owner users (one).
- The rate limit is for each pod. With two pods the real limit is double.
  Traefik has the limit for the whole Ingress (ARCHITECTURE 11.1).
- Requests with a bad token are not rate limited here (there is no
  subject). Traefik limits them. A bad token costs one RS256 check, and an
  unknown `kid` causes at most one JWKS fetch each 30 s (each 5 s while
  Keycloak is down).

## Commands

See `CLAUDE.md`.
