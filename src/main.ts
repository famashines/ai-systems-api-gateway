import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";
import { createApp } from "./app.ts";
import { Env } from "./env.ts";

const config = loadConfig(Env);
const { SERVICE_NAME: service, RELEASE: release } = config;
const telemetry = startTelemetry({ serviceName: service, release });
const app = createApp({
  verify: createJwtVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    requiredRole: config.REQUIRED_ROLE,
  }),
  orchestrationUrl: config.ORCHESTRATION_URL,
  projectionsUrl: config.PROJECTIONS_URL,
  logger: createLogger({ service, release, level: config.LOG_LEVEL }),
  metrics: telemetry.metricsHandler,
  closeHooks: [telemetry.shutdown],
});
await app.listen(config.PORT);
app.handleSignals();
