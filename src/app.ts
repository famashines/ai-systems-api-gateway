import {
  CommandEnvelopeV1,
  Id,
  ProblemJson,
  SubmitTaskCommandPayloadV1,
  TaskListResultV1,
} from "@famashines/ai-systems-contracts";
import { bearerHook, subjectOf, type JwtVerifier } from "@famashines/ai-systems-kit/auth";
import {
  createService,
  DomainError,
  UnavailableError,
  validate,
  ValidationError,
  type Reply,
  type Request,
  type Route,
  type Service,
  type ServiceOptions,
} from "@famashines/ai-systems-kit/http";
import { z } from "zod";
import { rateLimit, type RateLimitOptions } from "./rate-limit.ts";

export interface AppOptions {
  verify: JwtVerifier;
  orchestrationUrl: string;
  projectionsUrl: string;
  logger: ServiceOptions["logger"];
  metrics?: ServiceOptions["metrics"];
  closeHooks?: ServiceOptions["closeHooks"];
  drainDelayMs?: number;
  upstreamTimeoutMs?: number;
  rateLimit?: Partial<RateLimitOptions>;
}

const Accepted = z.object({ taskId: Id, version: z.int().min(1) });

const ListQuery = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .optional(),
  before: z.string().min(1).max(200).optional(),
});

const badGateway = (): DomainError =>
  new DomainError("unavailable", 502, "The upstream service gave an answer that is not valid");

interface Upstream {
  status: number;
  body: unknown;
}

export function createApp(options: AppOptions): Service {
  const { verify, logger, upstreamTimeoutMs = 5000 } = options;

  async function call(name: string, url: URL, request: Request, body?: unknown): Promise<Upstream> {
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "x-correlation-id": request.correlationId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      logger.warn({ err: error, upstream: name }, "the upstream call failed");
      throw new UnavailableError(`The ${name} service is not available`);
    }
  }

  function problem(upstream: Upstream, request: Request): Reply {
    const parsed = ProblemJson.loose().safeParse(upstream.body);
    if (upstream.status < 400 || !parsed.success || parsed.data.status !== upstream.status) {
      throw badGateway();
    }
    return {
      status: upstream.status,
      headers: { "content-type": "application/problem+json" },
      body: { ...parsed.data, instance: request.path },
    };
  }

  const routes: Route[] = [
    {
      method: "POST",
      path: "/api/tasks",
      handler: async (request) => {
        const key = Id.safeParse(request.headers["idempotency-key"]);
        if (!key.success) {
          throw new ValidationError("The request is not valid", [
            {
              path: "headers.idempotency-key",
              code: "invalid_format",
              message: "The Idempotency-Key header must be a lower-case UUID v4",
            },
          ]);
        }
        const { body } = await validate(request, { body: SubmitTaskCommandPayloadV1 });
        const command = CommandEnvelopeV1(SubmitTaskCommandPayloadV1).parse({
          commandId: key.data,
          type: "orchestration.SubmitTask",
          actor: { kind: "owner", id: subjectOf(request).sub },
          payload: body,
        });
        const upstream = await call(
          "orchestration",
          new URL("/internal/commands/submit-task", options.orchestrationUrl),
          request,
          command,
        );
        if (upstream.status !== 200 && upstream.status !== 201) return problem(upstream, request);
        const accepted = Accepted.safeParse(upstream.body);
        if (!accepted.success) throw badGateway();
        return {
          status: 202,
          headers: { location: `/api/tasks/${accepted.data.taskId}` },
          body: accepted.data,
        };
      },
    },
    {
      method: "GET",
      path: "/api/tasks",
      handler: async (request) => {
        const { query } = await validate(request, { query: ListQuery });
        const url = new URL("/internal/tasks", options.projectionsUrl);
        for (const [name, value] of Object.entries(query)) {
          if (value !== undefined) url.searchParams.set(name, value);
        }
        const upstream = await call("projections", url, request);
        if (upstream.status !== 200) return problem(upstream, request);
        const result = TaskListResultV1.safeParse(upstream.body);
        if (!result.success) throw badGateway();
        return { body: result.data };
      },
    },
  ];

  return createService({
    logger,
    routes,
    bodyLimit: 256 * 1024,
    before: [bearerHook(verify), rateLimit({ perSecond: 20, burst: 40, ...options.rateLimit })],
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.closeHooks ? { closeHooks: options.closeHooks } : {}),
    ...(options.drainDelayMs === undefined ? {} : { drainDelayMs: options.drainDelayMs }),
  });
}
