import {
  createJwtVerifier,
  type JwtVerifier,
  type JwtVerifierOptions,
} from "@famashines/ai-systems-kit/auth";
import { commonEnv } from "@famashines/ai-systems-kit/config";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const Env = commonEnv.extend({
  SERVICE_NAME: z.string().min(1).default("ai-systems-api-gateway"),
  ORCHESTRATION_URL: httpUrl,
  CONVERSATION_HUB_URL: httpUrl.default("http://ai-systems-conversation-hub:8080"),
  PROJECTIONS_URL: httpUrl,
  BUDGET_URL: httpUrl.default("http://ai-systems-budget:8080"),
  AI_PROXY_URL: httpUrl.default("http://ai-systems-ai-proxy:8080"),
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  REQUIRED_ROLE: z.string().min(1).default("owner"),
  OWNER_WITHOUT_LOGIN: z.string().min(1).optional(),
});

export const verifierOptions = (config: z.output<typeof Env>): JwtVerifierOptions => ({
  issuer: config.OIDC_ISSUER,
  audience: config.OIDC_AUDIENCE,
  requiredRole: config.REQUIRED_ROLE,
  ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
});

export const ownerVerifier = (
  config: z.output<typeof Env>,
  logger: NonNullable<JwtVerifierOptions["logger"]>,
): JwtVerifier => {
  const sub = config.OWNER_WITHOUT_LOGIN;
  if (sub === undefined) return createJwtVerifier({ ...verifierOptions(config), logger });
  logger.warn({ sub }, "login is off: each request acts as the owner");
  return () =>
    Promise.resolve({ sub, roles: [config.REQUIRED_ROLE], exp: Number.MAX_SAFE_INTEGER });
};
