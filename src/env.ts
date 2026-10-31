import type { JwtVerifierOptions } from "@famashines/ai-systems-kit/auth";
import { commonEnv } from "@famashines/ai-systems-kit/config";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const Env = commonEnv.extend({
  SERVICE_NAME: z.string().min(1).default("ai-systems-api-gateway"),
  ORCHESTRATION_URL: httpUrl,
  CONVERSATION_HUB_URL: httpUrl.default("http://ai-systems-conversation-hub:8080"),
  PROJECTIONS_URL: httpUrl,
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  REQUIRED_ROLE: z.string().min(1).default("owner"),
});

export const verifierOptions = (config: z.output<typeof Env>): JwtVerifierOptions => ({
  issuer: config.OIDC_ISSUER,
  audience: config.OIDC_AUDIENCE,
  requiredRole: config.REQUIRED_ROLE,
  ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
});
