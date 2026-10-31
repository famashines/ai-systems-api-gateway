# Changelog

## 0.1.0

- kit/http server with the kit/auth bearer hook on all `/api` paths.
  `/health`, `/ready` and `/metrics` stay open.
- `POST /api/tasks`: `Idempotency-Key` check, SubmitTask command to
  orchestration, 202 with `Location`.
- `GET /api/tasks`: the task list from projections, checked with zod.
- Rate limit for each subject (token bucket, 20 each second, burst 40).
- Dockerfile (Node 26 slim by digest, uid 1000, read-only root file
  system) and CI (gitleaks, verify, audit, image build and smoke test).
