import { subjectOf } from "@famashines/ai-systems-kit/auth";
import { RateLimitedError, type Hook } from "@famashines/ai-systems-kit/http";

export interface RateLimitOptions {
  perSecond: number;
  burst: number;
  now?: () => number;
}

export function rateLimit({ perSecond, burst, now = Date.now }: RateLimitOptions): Hook {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (request) => {
    const { sub } = subjectOf(request);
    const at = now();
    const last = buckets.get(sub);
    const tokens = last
      ? Math.min(burst, last.tokens + ((at - last.at) / 1000) * perSecond)
      : burst;
    if (tokens < 1) {
      buckets.set(sub, { tokens, at });
      const seconds = Math.max(1, Math.ceil((1 - tokens) / perSecond));
      throw new RateLimitedError("Too many requests", { "retry-after": String(seconds) });
    }
    buckets.set(sub, { tokens: tokens - 1, at });
  };
}
