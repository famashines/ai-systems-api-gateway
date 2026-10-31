# Changelog

## Unreleased

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
