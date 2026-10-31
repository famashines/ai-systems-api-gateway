import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import {
  ConflictError,
  createService,
  validate,
  ValidationError,
  type Service,
} from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { CommandEnvelopeV1, SubmitTaskCommandPayloadV1 } from "@famashines/ai-systems-contracts";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { z } from "zod";
import { createApp, type AppOptions } from "./app.ts";
import { Env } from "./env.ts";

const issuer = "https://auth.example.test/realms/ai-systems";
const logger = createLogger({ service: "test", release: "test", level: "silent" });

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

type Behaviour = (seen: Seen, response: ServerResponse) => void;

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

const fake = () => {
  const seen: Seen[] = [];
  let behaviour: Behaviour = (_seen, response) => response.writeHead(500).end();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
      };
      seen.push(entry);
      behaviour(entry, response);
    });
  });
  return {
    server,
    seen,
    set: (next: Behaviour) => {
      behaviour = next;
    },
  };
};

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
) => {
  response.writeHead(status, { "content-type": type }).end(JSON.stringify(body));
};

let privateKey: CryptoKey;
let jwks: Server;
let jwksUrl: string;
const orchestration = fake();
const projections = fake();
let orchestrationUrl: string;
let projectionsUrl: string;
const services: Service[] = [];

before(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createServer((_request, response) => {
    json(response, 200, { keys: [jwk] });
  });
  jwksUrl = `${await listen(jwks)}/certs`;
  orchestrationUrl = await listen(orchestration.server);
  projectionsUrl = await listen(projections.server);
});

after(async () => {
  await Promise.all(services.map((service) => service.close()));
  for (const server of [jwks, orchestration.server, projections.server]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  orchestration.seen.length = 0;
  projections.seen.length = 0;
});

const now = (): number => Math.floor(Date.now() / 1000);

const sign = (claims: Record<string, unknown> = {}): Promise<string> =>
  new SignJWT({
    iss: issuer,
    aud: ["ai-systems-app", "account"],
    sub: "owner-1",
    iat: now(),
    exp: now() + 300,
    typ: "Bearer",
    realm_access: { roles: ["owner"] },
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(privateKey);

const start = async (options: Partial<AppOptions> = {}) => {
  const service = createApp({
    verify: createJwtVerifier({
      issuer,
      audience: "ai-systems-app",
      requiredRole: "owner",
      jwksUrl,
    }),
    orchestrationUrl,
    projectionsUrl,
    logger,
    drainDelayMs: 0,
    ...options,
  });
  services.push(service);
  const { port } = await service.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${String(port)}`;
  return (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
};

const authed = async (headers: Record<string, string> = {}): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await sign()}`,
  ...headers,
});

const submit = async (
  body: unknown,
  key: string = randomUUID(),
  extra: Record<string, string> = {},
) => ({
  method: "POST",
  headers: await authed({ "content-type": "application/json", "idempotency-key": key, ...extra }),
  body: JSON.stringify(body),
});

const replaying = () => {
  const tasks = new Map<string, string>();
  orchestration.set((seen, response) => {
    const { commandId } = seen.body as { commandId: string };
    const known = tasks.get(commandId);
    const taskId = known ?? randomUUID();
    tasks.set(commandId, taskId);
    json(response, known ? 200 : 201, { taskId, version: 1 });
  });
  return tasks;
};

const empty = { items: [], headSeq: 0 };

const problemOf = async (response: Response) => {
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  return (await response.json()) as { code: string; status: number; instance: string };
};

describe("auth", () => {
  test("no token, a bad token or another scheme gives 401, also on an unknown path", async () => {
    const call = await start();
    const bad = await sign({ iss: "https://evil.example.test" });
    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      { authorization: `Bearer ${bad}` },
      { authorization: "Bearer abc.def.ghi" },
      { authorization: "Basic YTpi" },
    ];
    for (const headers of cases) {
      for (const [method, path] of [
        ["POST", "/api/tasks"],
        ["GET", "/api/tasks"],
        ["GET", "/api/unknown"],
        ["DELETE", "/nothing"],
      ] as const) {
        const response = await call(path, { method, ...(headers ? { headers } : {}) });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer realm="ai-systems"/);
        assert.equal((await problemOf(response)).code, "unauthorized");
      }
    }
    assert.equal(orchestration.seen.length + projections.seen.length, 0);
  });

  test("health, ready and metrics stay open", async () => {
    const call = await start({
      metrics: (_request, response) => response.writeHead(200).end("up 1\n"),
    });
    assert.equal((await call("/health")).status, 200);
    assert.equal((await call("/ready")).status, 200);
    assert.equal(await (await call("/metrics")).text(), "up 1\n");
  });

  test("a token with no owner role gives 403", async () => {
    const call = await start();
    const token = await sign({ realm_access: { roles: ["default-roles-ai-systems"] } });
    const response = await call("/api/tasks", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
    assert.equal((await problemOf(response)).code, "forbidden");
  });

  test("a valid token on an unknown path gives 404", async () => {
    const call = await start();
    assert.equal((await call("/api/unknown", { headers: await authed() })).status, 404);
  });
});

describe("POST /api/tasks", () => {
  test("sends a SubmitTask command and gives 202 with the location", async () => {
    replaying();
    const call = await start();
    const key = randomUUID();
    const correlationId = randomUUID();
    const response = await call(
      "/api/tasks",
      await submit({ text: "Write a plan" }, key, { "x-correlation-id": correlationId }),
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as { taskId: string; version: number };
    assert.deepEqual(Object.keys(body).sort(), ["taskId", "version"]);
    assert.equal(response.headers.get("location"), `/api/tasks/${body.taskId}`);
    assert.equal(orchestration.seen.length, 1);
    const sent = orchestration.seen[0];
    assert.ok(sent);
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/internal/commands/submit-task");
    assert.equal(sent.headers["x-correlation-id"], correlationId);
    assert.equal(sent.headers.authorization, undefined);
    assert.deepEqual(sent.body, {
      commandId: key,
      type: "orchestration.SubmitTask",
      actor: { kind: "owner", id: "owner-1" },
      payload: { text: "Write a plan", mode: "approval" },
    });
  });

  test("the same key twice gives the same task", async () => {
    const tasks = replaying();
    const call = await start();
    const key = randomUUID();
    const first = await call("/api/tasks", await submit({ text: "Hi", mode: "auto" }, key));
    const second = await call("/api/tasks", await submit({ text: "Hi", mode: "auto" }, key));
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(first.headers.get("location"), second.headers.get("location"));
    assert.equal(tasks.size, 1);
    assert.equal(orchestration.seen.length, 2);
  });

  test("a bad Idempotency-Key gives 400 with no upstream call", async () => {
    replaying();
    const call = await start();
    for (const key of [
      undefined,
      "",
      "not-a-uuid",
      randomUUID().toUpperCase(),
      "6f1c3c7e-2d0a-1f3b-9a7e-000000000001",
      `${randomUUID()}, ${randomUUID()}`,
    ]) {
      const headers = await authed({ "content-type": "application/json" });
      if (key !== undefined) headers["idempotency-key"] = key;
      const response = await call("/api/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "Hi" }),
      });
      assert.equal(response.status, 400, String(key));
      const problem = (await problemOf(response)) as unknown as {
        code: string;
        errors: { path: string }[];
      };
      assert.equal(problem.code, "validation_failed");
      assert.equal(problem.errors[0]?.path, "headers.idempotency-key");
    }
    assert.equal(orchestration.seen.length, 0);
  });

  test("a bad body gives 400 with no upstream call", async () => {
    replaying();
    const call = await start();
    for (const body of [{}, { text: "" }, { text: "   " }, { text: "Hi", mode: "fast" }, []]) {
      const response = await call("/api/tasks", await submit(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await problemOf(response)).code, "validation_failed");
    }
    const response = await call("/api/tasks", {
      method: "POST",
      headers: await authed({
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      }),
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.equal(orchestration.seen.length, 0);
  });

  test("a problem from orchestration passes through with its status", async () => {
    orchestration.set((_seen, response) => {
      json(
        response,
        409,
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "conflict",
          detail: "The key was used for another command",
          instance: "/internal/commands/submit-task",
        },
        "application/problem+json",
      );
    });
    const call = await start();
    const response = await call("/api/tasks", await submit({ text: "Hi" }));
    assert.equal(response.status, 409);
    const problem = await problemOf(response);
    assert.equal(problem.code, "conflict");
    assert.equal(problem.instance, "/api/tasks");
  });

  test("orchestration down or too slow gives 503", async () => {
    const closed = createServer();
    const url = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const down = await start({ orchestrationUrl: url });
    const response = await down("/api/tasks", await submit({ text: "Hi" }));
    assert.equal(response.status, 503);
    assert.equal((await problemOf(response)).code, "unavailable");

    orchestration.set(() => undefined);
    const slow = await start({ upstreamTimeoutMs: 200 });
    const late = await slow("/api/tasks", await submit({ text: "Hi" }));
    assert.equal(late.status, 503);
    assert.equal((await problemOf(late)).code, "unavailable");
    orchestration.server.closeAllConnections();
  });

  test("a bad answer from orchestration gives 502", async () => {
    const call = await start();
    const answers: Behaviour[] = [
      (_seen, response) => {
        json(response, 201, { taskId: "x", version: 1 });
      },
      (_seen, response) => response.writeHead(201).end("not json"),
      (_seen, response) => response.writeHead(500).end("<html>"),
      (_seen, response) => {
        json(response, 503, { status: 500, title: "x", type: "x", code: "internal" });
      },
      (_seen, response) => {
        json(response, 204, {});
      },
    ];
    for (const answer of answers) {
      orchestration.set(answer);
      const response = await call("/api/tasks", await submit({ text: "Hi" }));
      assert.equal(response.status, 502);
      assert.equal((await problemOf(response)).code, "unavailable");
    }
  });
});

describe("with a kit service like orchestration PR #1", () => {
  const SubmitTaskBody = CommandEnvelopeV1(SubmitTaskCommandPayloadV1).extend({
    type: z.literal("orchestration.SubmitTask"),
    expectedVersion: z.literal(0).exactOptional(),
  });

  test("201 and 200 give 202; 400 with errors and 409 pass through", async () => {
    const answers = new Map<string, { taskId: string; version: number }>();
    const upstream = createService({
      logger,
      drainDelayMs: 0,
      routes: [
        {
          method: "POST",
          path: "/internal/commands/submit-task",
          handler: async (request) => {
            const { body } = await validate(request, { body: SubmitTaskBody });
            if (body.payload.text === "clash") throw new ConflictError();
            if (body.payload.text === "refused") {
              throw new ValidationError("The request is not valid", [
                { path: "body.payload.text", code: "custom", message: "refused" },
              ]);
            }
            const known = answers.get(body.commandId);
            const answer = known ?? { taskId: randomUUID(), version: 1 };
            answers.set(body.commandId, answer);
            return { status: known ? 200 : 201, body: answer };
          },
        },
      ],
    });
    services.push(upstream);
    const { port } = await upstream.listen(0, "127.0.0.1");
    const call = await start({ orchestrationUrl: `http://127.0.0.1:${String(port)}` });
    const key = randomUUID();
    const first = await call(
      "/api/tasks",
      await submit({ text: "Write a poem", mode: "auto" }, key),
    );
    const again = await call(
      "/api/tasks",
      await submit({ text: "Write a poem", mode: "auto" }, key),
    );
    assert.equal(first.status, 202);
    assert.equal(again.status, 202);
    const body = (await first.json()) as { taskId: string; version: number };
    assert.deepEqual(await again.json(), body);
    assert.equal(body.version, 1);
    assert.equal(first.headers.get("location"), `/api/tasks/${body.taskId}`);
    assert.equal(answers.size, 1);

    const refused = await call("/api/tasks", await submit({ text: "refused" }));
    assert.equal(refused.status, 400);
    const problem = (await problemOf(refused)) as unknown as {
      code: string;
      instance: string;
      errors: { path: string }[];
    };
    assert.equal(problem.code, "validation_failed");
    assert.equal(problem.instance, "/api/tasks");
    assert.deepEqual(
      problem.errors.map((issue) => issue.path),
      ["body.payload.text"],
    );

    const clash = await call("/api/tasks", await submit({ text: "clash" }));
    assert.equal(clash.status, 409);
    assert.equal((await problemOf(clash)).code, "conflict");
  });
});

describe("GET /api/tasks", () => {
  const oneTask = {
    items: [
      {
        taskId: randomUUID(),
        title: "Write a plan",
        status: "submitted",
        createdAt: "2026-10-31T08:00:00.000Z",
        updatedAt: "2026-10-31T08:00:00.000Z",
        rev: 1,
        asOf: 4,
      },
    ],
    headSeq: 4,
  };

  test("forwards limit and before to projections and gives the list", async () => {
    projections.set((_seen, response) => {
      json(response, 200, oneTask);
    });
    const call = await start();
    const correlationId = randomUUID();
    const before = randomUUID();
    const response = await call(`/api/tasks?limit=20&before=${before}&other=1`, {
      headers: await authed({ "x-correlation-id": correlationId }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), oneTask);
    const sent = projections.seen[0];
    assert.ok(sent);
    assert.equal(sent.url, `/internal/tasks?limit=20&before=${before}`);
    assert.equal(sent.headers["x-correlation-id"], correlationId);
    await call("/api/tasks", { headers: await authed() });
    assert.equal(projections.seen[1]?.url, "/internal/tasks");
  });

  test("a bad query gives 400", async () => {
    const call = await start();
    for (const query of ["limit=0", "limit=abc", "limit=1000", `before=${"x".repeat(201)}`]) {
      const response = await call(`/api/tasks?${query}`, { headers: await authed() });
      assert.equal(response.status, 400, query);
    }
    assert.equal(projections.seen.length, 0);
  });

  test("a bad answer from projections gives 502, a problem passes through", async () => {
    const call = await start();
    projections.set((_seen, response) => {
      json(response, 200, { items: [{ taskId: "x" }], headSeq: 1 });
    });
    const bad = await call("/api/tasks", { headers: await authed() });
    assert.equal(bad.status, 502);
    projections.set((_seen, response) => {
      json(response, 400, {
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        code: "validation_failed",
        errors: [{ path: "query.before", code: "invalid", message: "not valid" }],
      });
    });
    const refused = await call("/api/tasks?before=abc", { headers: await authed() });
    assert.equal(refused.status, 400);
    const problem = (await refused.json()) as { errors: unknown[]; instance: string };
    assert.equal(problem.errors.length, 1);
    assert.equal(problem.instance, "/api/tasks");
  });
});

describe("rate limit", () => {
  test("after the burst a subject gets 429 with Retry-After; another subject does not", async () => {
    projections.set((_seen, response) => {
      json(response, 200, empty);
    });
    let time = 1_000_000;
    const call = await start({ rateLimit: { perSecond: 2, burst: 3, now: () => time } });
    const owner = await authed();
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await call("/api/tasks", { headers: owner })).status, 200);
    }
    const limited = await call("/api/tasks", { headers: owner });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal((await problemOf(limited)).code, "rate_limited");
    const other = { authorization: `Bearer ${await sign({ sub: "owner-2" })}` };
    assert.equal((await call("/api/tasks", { headers: other })).status, 200);
    time += 500;
    assert.equal((await call("/api/tasks", { headers: owner })).status, 200);
    assert.equal((await call("/api/tasks", { headers: owner })).status, 429);
    time += 10_000;
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await call("/api/tasks", { headers: owner })).status, 200);
    }
    assert.equal((await call("/api/tasks", { headers: owner })).status, 429);
  });

  test("the default is 40 requests in a burst", async () => {
    projections.set((_seen, response) => {
      json(response, 200, empty);
    });
    const call = await start({ rateLimit: { now: () => 5_000_000 } });
    const owner = await authed();
    const statuses = await Promise.all(
      Array.from({ length: 41 }, async () => (await call("/api/tasks", { headers: owner })).status),
    );
    assert.equal(statuses.filter((status) => status === 200).length, 40);
    assert.equal(statuses.filter((status) => status === 429).length, 1);
  });
});

describe("env", () => {
  test("defaults and refused values", () => {
    const config = loadConfig(Env, {
      ORCHESTRATION_URL: "http://ai-systems-orchestration:8080",
      PROJECTIONS_URL: "http://ai-systems-projections:8080",
    });
    assert.equal(config.SERVICE_NAME, "ai-systems-api-gateway");
    assert.equal(config.OIDC_ISSUER, "https://auth.famashines.com/realms/ai-systems");
    assert.equal(config.OIDC_AUDIENCE, "ai-systems-app");
    assert.equal(config.REQUIRED_ROLE, "owner");
    assert.equal(config.PORT, 8080);
    assert.throws(() =>
      loadConfig(Env, { ORCHESTRATION_URL: "file:///etc/passwd", PROJECTIONS_URL: "x" }),
    );
    assert.throws(() => loadConfig(Env, {}));
  });
});
