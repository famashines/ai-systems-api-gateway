# ai-systems-api-gateway

HTTP API gateway of ai-systems. Traefik sends `/api` on `ai.famashines.com`
to it (ADR 0011, ADR 0021). It checks the Keycloak token and forwards
commands and queries to the services. It has no database and no NATS.

```
app --HTTPS /api--> Traefik --> api-gateway
                                  | bearerHook (kit/auth): 401, 403
                                  | rate limit for each subject: 429
                                  | zod checks: 400
                                  +--POST--> orchestration    /internal/commands/submit-task (with Authorization)
                                  +--POST--> orchestration    /internal/commands/<control> (with Authorization)
                                  +--POST--> conversation-hub /internal/commands/post-owner-message (with Authorization)
                                  +--POST--> budget           /internal/commands/set-budget (with Authorization)
                                  +--GET---> projections      /internal/tasks
                                  +--GET---> projections      /internal/conversations/<id>/messages
                                  +--GET---> ai-proxy         /internal/models
```

## Routes

| Route                                       | Does                                        |
| ------------------------------------------- | ------------------------------------------- |
| `GET /health`, `GET /ready`, `GET /metrics` | kit probes and Prometheus metrics, no token |
| `POST /api/tasks`                           | submit a task (below)                       |
| `GET /api/tasks?limit=&before=`             | the task list (below)                       |
| `GET /api/tasks/:id`                        | the task detail (below)                     |
| `GET /api/tasks/:id/output`                 | the result of the run (below)               |
| `GET /api/tasks/:id/subtasks/:sid/output`   | the output of a subtask (below)             |
| `POST /api/tasks/:id/<control>`             | an owner control of a task (below)          |
| `POST /api/conversations/:id/messages`      | post an owner message to a thread (below)   |
| `GET /api/conversations/:id/messages`       | the messages of a thread (below)            |
| `GET /api/budget?month=`                    | the budget of a month (below)               |
| `POST /api/budget`                          | set the monthly cap (below)                 |
| `GET /api/agents`                           | the agent list (below)                      |
| `GET /api/models`                           | the model list (below)                      |

All other paths need a valid token too: with no valid token, an unknown
path gives 401, not 404 (the hooks run before routing).

### Auth

kit/auth `createJwtVerifier` with `OIDC_ISSUER`, `OIDC_AUDIENCE` and
`REQUIRED_ROLE`. The keys come from `OIDC_JWKS_URL`, or from
`<OIDC_ISSUER>/protocol/openid-connect/certs` when it is not set. The token
`iss` must always be `OIDC_ISSUER`. On the cluster `OIDC_JWKS_URL` is the
in-cluster Keycloak URL, so the pod does not go out through Traefik.

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
`POST <ORCHESTRATION_URL>/internal/commands/submit-task`, with the
`Authorization` header of the request. Orchestration checks the owner
token itself, because a task can start a paid plan call (ADR 0028):

```json
{
  "commandId": "<Idempotency-Key>",
  "type": "orchestration.SubmitTask",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "text": "...", "mode": "approval" }
}
```

| Orchestration answer                             | Gateway answer                                  |
| ------------------------------------------------ | ----------------------------------------------- |
| 201 or 200 with `{ taskId, version }`            | 202, same body, `Location: /api/tasks/<taskId>` |
| problem JSON with 400, 403, 409, 413, 415 or 422 | same status and problem (allowed fields only)   |
| other answer (also 401, 500, 503)                | 502 `unavailable`, generic detail               |
| answer larger than 1 MiB                         | 502 `unavailable`                               |
| no answer in 5 s, or a network error             | 503 `unavailable`                               |

A problem that passes through keeps only `type`, `title`, `status`,
`code`, `detail` and `errors`; `instance` is the gateway path. Other
upstream fields (for example a stack or an internal URL) never reach the
client. The gateway logs the status of a refused answer at warn.

The same key again gives the same task: orchestration stores the
`commandId` with its answer and replays it (200).

`Location` is the URL of the task detail, `GET /api/tasks/<taskId>`.

### `POST /api/tasks/:id/<control>`

The owner controls of task M3-04. The path scheme: `<control>` is the
orchestration command name in kebab case, and the same name is the path of
the orchestration route.

| Route                                    | Command             | Body (the payload with no `taskId`)    |
| ---------------------------------------- | ------------------- | -------------------------------------- |
| `POST /api/tasks/:id/approve-plan`       | `ApprovePlan`       | `{ planVersion }`                      |
| `POST /api/tasks/:id/edit-plan`          | `EditPlan`          | `{ planVersion, subtasks }`            |
| `POST /api/tasks/:id/reject-plan`        | `RejectPlan`        | `{ planVersion, reason }`              |
| `POST /api/tasks/:id/pause-run`          | `PauseRun`          | `{}`                                   |
| `POST /api/tasks/:id/resume-run`         | `ResumeRun`         | `{}`                                   |
| `POST /api/tasks/:id/cancel-run`         | `CancelRun`         | `{ reason? }`                          |
| `POST /api/tasks/:id/cancel-task`        | `CancelTask`        | `{ reason? }`                          |
| `POST /api/tasks/:id/retry-subtask`      | `RetrySubtask`      | `{ subtaskId }`                        |
| `POST /api/tasks/:id/reassign-subtask`   | `ReassignSubtask`   | `{ subtaskId, agentId, model? }`       |
| `POST /api/tasks/:id/set-task-mode`      | `SetTaskMode`       | `{ mode }`                             |
| `POST /api/tasks/:id/resolve-checkpoint` | `ResolveCheckpoint` | `{ checkpointId, decision, comment? }` |

Request:

- `:id` is the `taskId`: a lower-case UUID v4, else 400 with the path
  `params.id`. A `taskId` in the body is replaced by `:id`.
- Header `Idempotency-Key`: the same rule as `POST /api/tasks`.
- Body: the fields of the command payload of contracts v0.5.0
  (`ApprovePlanCommandPayloadV1` and the others), else 400 with no
  upstream call.

The gateway sends this `CommandEnvelopeV1` to
`POST <ORCHESTRATION_URL>/internal/commands/<control>`, with the
`Authorization` header of the request:

```json
{
  "commandId": "<Idempotency-Key>",
  "type": "orchestration.ApprovePlan",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "taskId": "<:id>", "planVersion": 2 }
}
```

| Orchestration answer                                  | Gateway answer                                |
| ----------------------------------------------------- | --------------------------------------------- |
| 201 or 200 (replay) with `{ taskId, version }`        | 202, same body                                |
| a body with another `taskId`                          | 502 `unavailable`                             |
| problem JSON with 400, 403, 404, 409, 413, 415 or 422 | same status and problem (allowed fields only) |
| 401 (the gateway already accepted the token)          | 502 `unavailable`                             |
| other answers, size, timeout and network errors       | as for `POST /api/tasks`                      |

Orchestration checks the owner token itself (ADR 0028) and gives 403 when
`actor.id` is not the token `sub`, 404 for an unknown task, and 409
`conflict` when the task state cannot take the command or `planVersion`
is not the last version of the plan. The same key again gives the first
answer (200 from orchestration, 202 here). The JWT check, the owner role,
the rate limit and the problem rules are the same as on all routes.

### `GET /api/tasks`

- Query, all optional: `limit` (1 to 100), `before` (contracts
  `Timestamp`, ISO 8601 UTC) and `beforeId` (contracts `Id`, lower-case
  UUID v4, for tasks with the same time). Else 400. Other query keys are
  dropped.
- Forwards to `GET <PROJECTIONS_URL>/internal/tasks` and gives
  `TaskListResultV1`. The answer is checked with zod; a bad answer is 502.
  Problem JSON passes through as above.

### `POST /api/conversations/:id/messages`

Request:

- `:id` is the `conversationId`: a lower-case UUID v4, else 400 with the
  path `params.id`. The first message to a new id starts the thread.
- Header `Idempotency-Key`: the same rule as `POST /api/tasks`.
- Body: `{ text, taskId?, newTask?, mode?, model?, effort? }`, the fields
  of `PostOwnerMessageCommandPayloadV1` (contracts v0.5.0). `newTask` is
  `false` by default. `taskId` together with `newTask: true` is refused
  (400, path `body.taskId`). `mode` (`auto` or `approval`), `model` (a
  contracts `ModelId`, for example `openai/gpt-5`) and `effort` (a
  `ReasoningEffort`: `max`, `xhigh`, `high`, `medium`, `low`, `minimal` or
  `none`) are for a new task. `taskId` together with `mode`, `model` or
  `effort` is refused (400, path `body.taskId`). `effort` with no `model`
  is refused (400, path `body.effort`). conversation-hub copies `mode`,
  `model` and `effort` into the event only for a `new_task`. A
  `conversationId` in the body is replaced by `:id`.

The gateway sends this `CommandEnvelopeV1` to
`POST <CONVERSATION_HUB_URL>/internal/commands/post-owner-message`:

```json
{
  "commandId": "<Idempotency-Key>",
  "type": "conversation.PostOwnerMessage",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "conversationId": "<:id>", "text": "...", "newTask": false }
}
```

| conversation-hub answer                                          | Gateway answer                                |
| ---------------------------------------------------------------- | --------------------------------------------- |
| 201 or 200 with `{ conversationId, messageId, intent, taskId? }` | 202, same body                                |
| a body with another `conversationId`                             | 502 `unavailable`                             |
| problem JSON with 400, 403, 409, 413, 415 or 422                 | same status and problem (allowed fields only) |
| 401 (the gateway already accepted the token)                     | 502 `unavailable`                             |
| other answers, size, timeout and network errors                  | as for `POST /api/tasks`                      |

conversation-hub checks the owner token itself (M2-17, ADR 0028), so
this route also sends the `Authorization` header of the request.
conversation-hub gives 403 when `actor.id` is not the token `sub`.

`intent` is `new_task` or `steer` (with the `taskId` that the message
steers). conversation-hub gives 409 `conflict` for a `taskId` that is not
a task of the thread. The same key again gives the same message.

### `GET /api/conversations/:id/messages`

- `:id` as above. Query: `limit`, `before` and `beforeId`, the same rules
  as `GET /api/tasks`.
- Forwards to `GET <PROJECTIONS_URL>/internal/conversations/<id>/messages`
  and gives `ConversationThreadResultV1` (newest first). The answer is
  checked with zod; a bad answer is 502.
- projections gives 200 with empty `items` for an unknown thread. A page
  has at most 900 KiB of JSON, so it can have fewer items than `limit`.
  Only an empty page is the end. Use the last item as the cursor.

### `GET /api/budget`

- Query, optional: `month` (contracts `BudgetMonth`, `YYYY-MM`), else 400. With no `month`, projections gives the current month in the owner
  time zone. Other query keys are dropped.
- Forwards to `GET <PROJECTIONS_URL>/internal/budget` and gives
  `BudgetMonthV1`. The answer is checked with zod; a bad answer is 502.
- 404 `not_found` from projections (no cap is set and the month has no
  spend) passes through. The app shows "no cap set" for it. Only this
  route, the task detail routes and the owner controls pass a 404.

### `GET /api/tasks/:id` and the outputs

- `:id` (the `taskId`) and `:sid` (the `subtaskId`) are lower-case UUID
  v4, else 400 with no upstream call. No query; other query keys are
  dropped.
- Forwards to `GET <PROJECTIONS_URL>/internal/tasks/:id`,
  `/internal/tasks/:id/output` or `/internal/tasks/:id/subtasks/:sid/output`
  and gives `TaskDetailV1` or `TaskOutputV1`. The answer is checked with
  zod; a bad answer is 502.
- 404 `not_found` from projections (an unknown task, no result yet, or no
  output of the subtask yet) passes through.
- Read only: no `Authorization` header goes to projections.
- The app subscribes `task:<id>` first and then reads the detail
  (ARCHITECTURE 10.2). It reads an output again when a subtask becomes
  `done` or the task `completed`.

### `GET /api/agents`

- No query. Forwards to `GET <PROJECTIONS_URL>/internal/agents` and gives
  `AgentListResultV1`. A 404 or a bad answer is 502.

### `GET /api/models`

- The models that the OpenRouter key of ai-proxy can use, for the model
  choice of a task. No query; other query keys are dropped.
- Forwards to `GET <AI_PROXY_URL>/internal/models` and gives
  `ModelListResultV1` (at most 1000 items, sorted by `name`; each item has
  `id`, `name`, `efforts`, highest first, and an optional
  `defaultEffort`). The answer is checked with zod; a bad answer is 502.
- Problem JSON with 503 (ai-proxy has no model list) or with 400, 409,
  413, 415 or 422 passes through. A 404 or another answer is 502.
- Read only: no `Authorization` header goes to ai-proxy.

### `POST /api/budget`

Sets the monthly hard cap and an optional soft cap. The same path as the
month view, because it changes that view.

Request:

- Header `Idempotency-Key`: the same rule as `POST /api/tasks`.
- Body: `SetBudgetCommandPayloadV1` (contracts v0.5.0):
  `{ scope: { kind: "month" }, hardCapMicroUsd, softCapMicroUsd? }`,
  integer micro-USD, at most 1,000,000,000,000, the soft cap not above the
  hard cap. Else 400 with no upstream call.

The gateway sends this `CommandEnvelopeV1` to
`POST <BUDGET_URL>/internal/commands/set-budget`:

```json
{
  "commandId": "<Idempotency-Key>",
  "type": "budget.SetBudget",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "scope": { "kind": "month" }, "hardCapMicroUsd": 5000000 }
}
```

Budget checks the owner token itself and refuses an `actor.id` that is not
the token `sub`. So this route also sends the `Authorization` header of
the request to the upstream. Only the routes to an upstream that checks
the owner token send it: `POST /api/budget`,
`POST /api/conversations/:id/messages`, `POST /api/tasks` and
`POST /api/tasks/:id/<control>`. All other routes send only `accept`,
`content-type` and `x-correlation-id` (all routes to projections and
`GET /api/models`). There are no routes to
the commands of prompt-studio and agent-manager yet. When they come, they
must forward the header too (those services check the token, M2-17).

| Budget answer                                    | Gateway answer                                |
| ------------------------------------------------ | --------------------------------------------- |
| 201 or 200 (replay) with `{ version }`           | 202, same body                                |
| problem JSON with 400, 403, 409, 413, 415 or 422 | same status and problem (allowed fields only) |
| 401 (the gateway already accepted the token)     | 502 `unavailable`                             |
| other answers, size, timeout and network errors  | as for `POST /api/tasks`                      |

Budget gives 400 for a scope other than `month` (M2), 403 when the token
has no `owner` role or `actor.id` is not its `sub`, and 409 `conflict` for
a concurrent change of the cap. The new cap reaches the month view
through projections, so the app sees it with the next `budget` notice.

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

| Variable                                                            | Default                                             |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| `ORCHESTRATION_URL`                                                 | required, `http` or `https` origin                  |
| `CONVERSATION_HUB_URL`                                              | `http://ai-systems-conversation-hub:8080`           |
| `PROJECTIONS_URL`                                                   | required, `http` or `https` origin                  |
| `BUDGET_URL`                                                        | `http://ai-systems-budget:8080`                     |
| `AI_PROXY_URL`                                                      | `http://ai-systems-ai-proxy:8080`                   |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems`     |
| `OIDC_JWKS_URL`                                                     | none: `<OIDC_ISSUER>/protocol/openid-connect/certs` |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                    |
| `REQUIRED_ROLE`                                                     | `owner`                                             |
| `PORT`                                                              | `8080`                                              |
| `LOG_LEVEL`                                                         | `info`                                              |
| `RELEASE`                                                           | `local`                                             |
| `SERVICE_NAME`                                                      | `ai-systems-api-gateway`                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none: no trace export                               |
| `OTEL_RESOURCE_ATTRIBUTES`                                          | none                                                |

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
- On the cluster, the owner controls need `OIDC_JWKS_URL` on
  orchestration and an egress from orchestration to Keycloak (gitops).
  api-gateway can already connect to orchestration.
- On the cluster, `POST /api/budget` needs a NetworkPolicy that lets
  api-gateway connect to budget on port 8080 (egress of api-gateway,
  ingress of budget). The policy is in `platform/gitops`.
- On the cluster, `GET /api/models` needs a NetworkPolicy that lets
  api-gateway connect to ai-proxy on port 8080 (egress of api-gateway,
  ingress of ai-proxy). The policy is in `platform/gitops`.
- The upstream timeout is 5 s. ai-proxy waits up to 10 s for the OpenRouter
  model list when its cache is empty or older than 6 hours. Then the first
  `GET /api/models` can give 503 while ai-proxy fills its cache; a retry
  gets the list.
- Requests with a bad token are not rate limited here (there is no
  subject). Traefik limits them. A bad token costs one RS256 check, and an
  unknown `kid` causes at most one JWKS fetch each 30 s (each 5 s while
  Keycloak is down).

## Commands

See `CLAUDE.md`.
