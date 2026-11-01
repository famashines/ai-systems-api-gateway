# Changelog

## Unreleased

- Contracts v0.4.1. `POST /api/conversations/:id/messages` forwards the
  optional `mode` of a new task, and refuses `mode` with a `taskId` (400).
- `GET /api/tasks/:id` (`TaskDetailV1`), `GET /api/tasks/:id/output` and
  `GET /api/tasks/:id/subtasks/:sid/output` (`TaskOutputV1`) from
  projections (M3-07). A 404 from projections passes through. No
  `Authorization` header goes to projections.

- `POST /api/conversations/:id/messages` forwards the `Authorization`
  header of the owner to conversation-hub, which checks the owner token
  now (M2-17, ADR 0028). A 403 from conversation-hub passes through. Only
  this route and `POST /api/budget` forward the header.

- `POST /api/budget`: `Idempotency-Key` check, `SetBudget` command to
  budget (`/internal/commands/set-budget`) with the `Authorization` header
  of the owner (only on this route), 202 with `{ version }`. 400, 403 and
  409 from budget pass through.
- New env `BUDGET_URL`, default `http://ai-systems-budget:8080`.

- `GET /api/budget?month=`: the month view (`BudgetMonthV1`) from
  projections; a 404 from projections passes through.
- `GET /api/agents`: the agent list (`AgentListResultV1`) from projections.

- `POST /api/conversations/:id/messages`: `Idempotency-Key` check,
  `PostOwnerMessage` command to conversation-hub, 202 with
  `{ conversationId, messageId, intent, taskId? }`.
- `GET /api/conversations/:id/messages`: the thread from projections
  (`/internal/conversations/:id/messages`, task M2-07), checked with
  `ConversationThreadResultV1`.
- New env `CONVERSATION_HUB_URL`, default
  `http://ai-systems-conversation-hub:8080`.
- Contracts v0.3.0 and kit v0.3.0.

- Optional `OIDC_JWKS_URL`: the verifier reads the keys from it; the `iss`
  check stays `OIDC_ISSUER`.
- Release workflow: image, CycloneDX SBOM, grype scan, push to GHCR
  by tag and digest, and a release pull request in `famashines/gitops`.

## 0.1.0

- kit/http server with the kit/auth bearer hook on all `/api` paths.
  `/health`, `/ready` and `/metrics` stay open.
- `POST /api/tasks`: `Idempotency-Key` check, SubmitTask command to
  orchestration, 202 with `Location`.
- `GET /api/tasks`: the task list from projections, checked with zod.
- Rate limit for each subject (token bucket, 20 each second, burst 40).
- Dockerfile (Node 26 slim by digest, uid 1000, read-only root file
  system) and CI (gitleaks, verify, audit, image build and smoke test).
- Review fixes: problems pass through only for 400, 409, 413, 415 and 422,
  with allowed fields only; other upstream answers give 502. Upstream
  answers over 1 MiB give 502. `GET /api/tasks` takes `limit` 1 to 100,
  `before` (Timestamp) and `beforeId` (Id). The JWKS failure log goes to
  the service logger. Image: `npm ci --omit=dev --omit=optional`, no npm
  or npx, `ENTRYPOINT`, early exit on a signal during start.
