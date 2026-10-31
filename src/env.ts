import { commonEnv } from "@famashines/ai-systems-kit/config";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const Env = commonEnv.extend({
  SERVICE_NAME: z.string().min(1).default("ai-systems-api-gateway"),
  ORCHESTRATION_URL: httpUrl,
  PROJECTIONS_URL: httpUrl,
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  REQUIRED_ROLE: z.string().min(1).default("owner"),
});
