const early = (): never => process.exit(143);
process.once("SIGTERM", early);
process.once("SIGINT", early);

const { createJwtVerifier } = await import("@famashines/ai-systems-kit/auth");
const { loadConfig } = await import("@famashines/ai-systems-kit/config");
const { createLogger, startTelemetry } = await import("@famashines/ai-systems-kit/observability");
const { createApp } = await import("./app.ts");
const { Env, verifierOptions } = await import("./env.ts");

const config = loadConfig(Env);
const { SERVICE_NAME: service, RELEASE: release } = config;
const telemetry = startTelemetry({ serviceName: service, release });
const logger = createLogger({ service, release, level: config.LOG_LEVEL });
const app = createApp({
  verify: createJwtVerifier({ ...verifierOptions(config), logger }),
  orchestrationUrl: config.ORCHESTRATION_URL,
  conversationHubUrl: config.CONVERSATION_HUB_URL,
  projectionsUrl: config.PROJECTIONS_URL,
  logger,
  metrics: telemetry.metricsHandler,
  closeHooks: [telemetry.shutdown],
});
await app.listen(config.PORT);
process.off("SIGTERM", early);
process.off("SIGINT", early);
app.handleSignals();
