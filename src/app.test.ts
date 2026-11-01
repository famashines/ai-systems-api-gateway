import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { bearerHook, createJwtVerifier, subjectOf } from "@famashines/ai-systems-kit/auth";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import {
  ConflictError,
  createService,
  ForbiddenError,
  validate,
  ValidationError,
  type Service,
} from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  CommandEnvelopeV1,
  SetBudgetCommandPayloadV1,
  SubmitTaskCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { z } from "zod";
import { createApp, type AppOptions } from "./app.ts";
import { Env, verifierOptions } from "./env.ts";

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
const conversationHub = fake();
const projections = fake();
const budget = fake();
let orchestrationUrl: string;
let conversationHubUrl: string;
let projectionsUrl: string;
let budgetUrl: string;
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
  conversationHubUrl = await listen(conversationHub.server);
  projectionsUrl = await listen(projections.server);
  budgetUrl = await listen(budget.server);
});

after(async () => {
  await Promise.all(services.map((service) => service.close()));
  for (const server of [
    jwks,
    orchestration.server,
    conversationHub.server,
    projections.server,
    budget.server,
  ]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  orchestration.seen.length = 0;
  conversationHub.seen.length = 0;
  projections.seen.length = 0;
  budget.seen.length = 0;
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
    azp: "ai-systems-app",
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
    conversationHubUrl,
    projectionsUrl,
    budgetUrl,
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
        ["POST", `/api/conversations/${randomUUID()}/messages`],
        ["GET", `/api/conversations/${randomUUID()}/messages`],
        ["GET", "/api/budget"],
        ["GET", "/api/agents"],
        ["GET", "/api/unknown"],
        ["DELETE", "/nothing"],
      ] as const) {
        const response = await call(path, { method, ...(headers ? { headers } : {}) });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer realm="ai-systems"/);
        assert.equal((await problemOf(response)).code, "unauthorized");
      }
    }
    assert.equal(
      orchestration.seen.length + conversationHub.seen.length + projections.seen.length,
      0,
    );
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
    for (const path of ["/api/tasks", "/api/budget", "/api/agents"]) {
      const response = await call(path, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403, path);
      assert.equal((await problemOf(response)).code, "forbidden");
    }
    assert.equal(projections.seen.length, 0);
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
          stack: "Error at /app/src/x.ts:1",
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
    assert.deepEqual(Object.keys(problem).sort(), [
      "code",
      "detail",
      "instance",
      "status",
      "title",
      "type",
    ]);
  });

  test("other upstream statuses give 502 with a generic detail and no upstream fields", async () => {
    const call = await start();
    for (const status of [500, 401, 403, 404, 429, 503]) {
      orchestration.set((_seen, response) => {
        json(
          response,
          status,
          {
            type: "about:blank",
            title: "Internal Server Error",
            status,
            code: "internal",
            detail: "password=hunter2 at mongodb://orchestration:secret@mongo",
            stack: "Error: boom\n    at /app/src/main.ts:10",
            internalUrl: "http://ai-systems-orchestration:8080/internal/commands/submit-task",
          },
          "application/problem+json",
        );
      });
      const response = await call("/api/tasks", await submit({ text: "Hi" }));
      assert.equal(response.status, 502, String(status));
      const text = await response.text();
      assert.doesNotMatch(text, /hunter2|secret|stack|internalUrl|ai-systems-orchestration/);
      const problem = JSON.parse(text) as { code: string; detail: string };
      assert.equal(problem.code, "unavailable");
      assert.equal(problem.detail, "The upstream service gave an answer that is not valid");
    }
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
    const before = "2026-10-31T08:00:00.000Z";
    const beforeId = randomUUID();
    const response = await call(
      `/api/tasks?limit=100&before=${before}&beforeId=${beforeId}&other=1`,
      {
        headers: await authed({ "x-correlation-id": correlationId }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), oneTask);
    const sent = projections.seen[0];
    assert.ok(sent);
    assert.equal(
      sent.url,
      `/internal/tasks?limit=100&before=${encodeURIComponent(before)}&beforeId=${beforeId}`,
    );
    assert.equal(sent.headers["x-correlation-id"], correlationId);
    await call("/api/tasks", { headers: await authed() });
    assert.equal(projections.seen[1]?.url, "/internal/tasks");
  });

  test("a bad query gives 400", async () => {
    const call = await start();
    for (const query of [
      "limit=0",
      "limit=abc",
      "limit=101",
      "limit=01",
      "before=yesterday",
      "before=2026-10-31",
      `beforeId=${randomUUID().toUpperCase()}`,
      "beforeId=1",
    ]) {
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

const posting = () => {
  const answers = new Map<string, unknown>();
  conversationHub.set((seen, response) => {
    const { commandId, payload } = seen.body as {
      commandId: string;
      payload: { conversationId: string; taskId?: string };
    };
    const known = answers.get(commandId);
    const answer = known ?? {
      conversationId: payload.conversationId,
      messageId: randomUUID(),
      ...(payload.taskId === undefined
        ? { intent: "new_task" }
        : { intent: "steer", taskId: payload.taskId }),
    };
    answers.set(commandId, answer);
    json(response, known ? 200 : 201, answer);
  });
  return answers;
};

describe("GET /api/tasks/:id and the outputs", () => {
  const taskId = "0b9d3c4e-6f1a-4c2b-9d8e-7a6b5c4d3e2f";
  const runId = "1c8e2b3d-5a4f-4e6d-8c7b-9a0b1c2d3e4f";
  const subtaskId = "2d7f1a2b-4c3e-4d5f-9b6a-8e7f6d5c4b3a";
  const detail = {
    taskId,
    title: "Plan",
    status: "running",
    mode: "auto",
    createdAt: "2026-10-31T09:15:00.000Z",
    updatedAt: "2026-10-31T09:16:00.000Z",
    runId,
    currentCall: { callId: subtaskId, kind: "plan" },
    subtasks: [],
    checkpoints: [],
    costMicroUsd: 10,
    rev: 3,
    asOf: 3,
  };
  const output = { taskId, runId, subtaskId, text: "Part" };
  const notFound = (seen: Seen, response: ServerResponse) => {
    json(
      response,
      404,
      {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "The task does not exist",
        instance: seen.url,
      },
      "application/problem+json",
    );
  };

  test("gives the detail and the outputs from projections, with no Authorization", async () => {
    const call = await start();
    projections.set((seen, response) => {
      json(response, 200, seen.url.endsWith("/output") ? output : detail);
    });
    const response = await call(`/api/tasks/${taskId}?x=1`, { headers: await authed() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), detail);
    const part = await call(`/api/tasks/${taskId}/subtasks/${subtaskId}/output`, {
      headers: await authed(),
    });
    assert.deepEqual(await part.json(), output);
    const result = await call(`/api/tasks/${taskId}/output`, { headers: await authed() });
    assert.equal(result.status, 200);
    assert.deepEqual(
      projections.seen.map((seen) => seen.url),
      [
        `/internal/tasks/${taskId}`,
        `/internal/tasks/${taskId}/subtasks/${subtaskId}/output`,
        `/internal/tasks/${taskId}/output`,
      ],
    );
    for (const seen of projections.seen) assert.equal(seen.headers.authorization, undefined);
  });

  test("a bad id gives 400 and no token gives 401, with no upstream call", async () => {
    const call = await start();
    for (const path of [
      "/api/tasks/x",
      "/api/tasks/x/output",
      `/api/tasks/${taskId}/subtasks/x/output`,
    ]) {
      assert.equal((await call(path, { headers: await authed() })).status, 400, path);
    }
    assert.equal((await call(`/api/tasks/${taskId}`)).status, 401);
    assert.equal(projections.seen.length, 0);
  });

  test("404 from projections passes through; a bad answer gives 502", async () => {
    const call = await start();
    projections.set(notFound);
    for (const path of [`/api/tasks/${taskId}`, `/api/tasks/${taskId}/output`]) {
      const missing = await call(path, { headers: await authed() });
      assert.equal(missing.status, 404);
      const body = await problemOf(missing);
      assert.equal(body.code, "not_found");
      assert.equal(body.instance, path);
    }
    projections.set((_seen, response) => {
      json(response, 200, { ...detail, currentCall: { callId: subtaskId, kind: "subtask" } });
    });
    assert.equal((await call(`/api/tasks/${taskId}`, { headers: await authed() })).status, 502);
    projections.set((_seen, response) => {
      json(response, 200, { taskId, runId });
    });
    assert.equal(
      (await call(`/api/tasks/${taskId}/output`, { headers: await authed() })).status,
      502,
    );
  });
});

describe("POST /api/conversations/:id/messages", () => {
  const conversationId = randomUUID();
  const path = `/api/conversations/${conversationId}/messages`;

  test("sends a PostOwnerMessage command and gives 202 with the intent", async () => {
    posting();
    const call = await start();
    const key = randomUUID();
    const correlationId = randomUUID();
    const taskId = randomUUID();
    const request = await submit(
      { text: "Make it shorter", taskId, conversationId: randomUUID() },
      key,
      { "x-correlation-id": correlationId },
    );
    const response = await call(path, request);
    assert.equal(response.status, 202);
    const body = (await response.json()) as { messageId: string };
    assert.deepEqual(body, { conversationId, messageId: body.messageId, intent: "steer", taskId });
    assert.equal(conversationHub.seen.length, 1);
    const sent = conversationHub.seen[0];
    assert.ok(sent);
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/internal/commands/post-owner-message");
    assert.equal(sent.headers["x-correlation-id"], correlationId);
    assert.equal(sent.headers.authorization, request.headers.authorization);
    assert.deepEqual(sent.body, {
      commandId: key,
      type: "conversation.PostOwnerMessage",
      actor: { kind: "owner", id: "owner-1" },
      payload: { conversationId, text: "Make it shorter", taskId, newTask: false },
    });
    assert.equal(orchestration.seen.length, 0);
  });

  test("passes the mode of a new task to conversation-hub", async () => {
    posting();
    const call = await start();
    const key = randomUUID();
    const response = await call(path, await submit({ text: "Write a poem", mode: "auto" }, key));
    assert.equal(response.status, 202);
    assert.deepEqual(conversationHub.seen[0]?.body, {
      commandId: key,
      type: "conversation.PostOwnerMessage",
      actor: { kind: "owner", id: "owner-1" },
      payload: { conversationId, text: "Write a poem", newTask: false, mode: "auto" },
    });
  });

  test("the same key twice gives the same message", async () => {
    const answers = posting();
    const call = await start();
    const key = randomUUID();
    const first = await call(path, await submit({ text: "Hi", newTask: true }, key));
    const second = await call(path, await submit({ text: "Hi", newTask: true }, key));
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(answers.size, 1);
    assert.equal(conversationHub.seen.length, 2);
  });

  test("a bad key, body or conversation id gives 400 with no upstream call", async () => {
    posting();
    const call = await start();
    const noKey = await call(path, {
      method: "POST",
      headers: await authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Hi" }),
    });
    assert.equal(noKey.status, 400);
    const cases: [string, unknown, string][] = [
      [path, {}, "body.text"],
      [path, { text: " " }, "body.text"],
      [path, { text: "a".repeat(20001) }, "body.text"],
      [path, { text: "Hi", taskId: "x" }, "body.taskId"],
      [path, { text: "Hi", taskId: randomUUID(), newTask: true }, "body.taskId"],
      [path, { text: "Hi", newTask: "yes" }, "body.newTask"],
      [path, { text: "Hi", mode: "fast" }, "body.mode"],
      [path, { text: "Hi", taskId: randomUUID(), mode: "auto" }, "body.mode"],
      [path, [], "body"],
      ["/api/conversations/not-a-uuid/messages", { text: "Hi" }, "params.id"],
      [`/api/conversations/${randomUUID().toUpperCase()}/messages`, { text: "Hi" }, "params.id"],
    ];
    for (const [target, body, issuePath] of cases) {
      const response = await call(target, await submit(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      const problem = (await problemOf(response)) as unknown as {
        code: string;
        errors: { path: string }[];
      };
      assert.equal(problem.code, "validation_failed");
      assert.ok(
        problem.errors.some((issue) => issue.path === issuePath),
        `${issuePath} ${JSON.stringify(problem.errors)}`,
      );
    }
    assert.equal(conversationHub.seen.length, 0);
  });

  test("a 403 or 409 from conversation-hub passes through, other answers give 502 or 503", async () => {
    const call = await start();
    for (const [status, code] of [
      [403, "forbidden"],
      [409, "conflict"],
    ] as const) {
      conversationHub.set((_seen, response) => {
        json(
          response,
          status,
          { type: "about:blank", title: "No", status, code, detail: "No" },
          "application/problem+json",
        );
      });
      const passed = await call(path, await submit({ text: "Hi", taskId: randomUUID() }));
      assert.equal(passed.status, status);
      const problem = await problemOf(passed);
      assert.equal(problem.code, code);
      assert.equal(problem.instance, path);
    }
    const bad: Behaviour[] = [
      (_seen, response) => {
        json(response, 401, {
          type: "about:blank",
          title: "No",
          status: 401,
          code: "unauthorized",
        });
      },
      (_seen, response) => {
        json(response, 500, { type: "x", title: "x", status: 500, code: "internal" });
      },
      (_seen, response) => {
        json(response, 201, {
          conversationId: randomUUID(),
          messageId: randomUUID(),
          intent: "new_task",
        });
      },
      (_seen, response) => {
        json(response, 201, { conversationId, messageId: randomUUID(), intent: "later" });
      },
      (_seen, response) => response.writeHead(201).end("not json"),
    ];
    for (const answer of bad) {
      conversationHub.set(answer);
      const response = await call(path, await submit({ text: "Hi" }));
      assert.equal(response.status, 502);
      assert.equal((await problemOf(response)).code, "unavailable");
    }
    const closed = createServer();
    const url = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const down = await start({ conversationHubUrl: url });
    const response = await down(path, await submit({ text: "Hi" }));
    assert.equal(response.status, 503);
    assert.equal((await problemOf(response)).code, "unavailable");
  });
});

describe("GET /api/conversations/:id/messages", () => {
  const conversationId = randomUUID();
  const thread = {
    items: [
      {
        role: "agent",
        messageId: randomUUID(),
        text: "Here is the poem",
        taskId: randomUUID(),
        createdAt: "2026-10-31T08:01:00.000Z",
        rev: 1,
        asOf: 5,
      },
      {
        role: "owner",
        messageId: randomUUID(),
        text: "Write a poem",
        intent: "new_task",
        createdAt: "2026-10-31T08:00:00.000Z",
        rev: 1,
        asOf: 2,
      },
    ],
    headSeq: 7,
  };

  test("forwards the page query to projections and gives the thread", async () => {
    projections.set((_seen, response) => {
      json(response, 200, thread);
    });
    const call = await start();
    const before = "2026-10-31T08:00:00.000Z";
    const beforeId = randomUUID();
    const response = await call(
      `/api/conversations/${conversationId}/messages?limit=20&before=${before}&beforeId=${beforeId}&x=1`,
      { headers: await authed() },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), thread);
    assert.equal(
      projections.seen[0]?.url,
      `/internal/conversations/${conversationId}/messages?limit=20&before=${encodeURIComponent(before)}&beforeId=${beforeId}`,
    );
    await call(`/api/conversations/${conversationId}/messages`, { headers: await authed() });
    assert.equal(projections.seen[1]?.url, `/internal/conversations/${conversationId}/messages`);
  });

  test("a bad id or query gives 400 with no upstream call", async () => {
    const call = await start();
    for (const target of [
      "/api/conversations/x/messages",
      `/api/conversations/${conversationId}/messages?limit=0`,
      `/api/conversations/${conversationId}/messages?before=yesterday`,
    ]) {
      const response = await call(target, { headers: await authed() });
      assert.equal(response.status, 400, target);
    }
    assert.equal(projections.seen.length, 0);
  });

  test("a bad answer from projections gives 502", async () => {
    const call = await start();
    projections.set((_seen, response) => {
      json(response, 200, { items: [{ role: "agent", text: "x" }], headSeq: 1 });
    });
    const response = await call(`/api/conversations/${conversationId}/messages`, {
      headers: await authed(),
    });
    assert.equal(response.status, 502);
  });
});

describe("GET /api/budget", () => {
  const month = {
    month: "2026-10",
    capMicroUsd: 1000,
    spentMicroUsd: 1200,
    reservedMicroUsd: 0,
    remainingMicroUsd: 0,
    overCapMicroUsd: 200,
    rev: 3,
    asOf: 2,
  };

  test("forwards the month to projections and gives the month view", async () => {
    projections.set((_seen, response) => {
      json(response, 200, month);
    });
    const call = await start();
    const response = await call("/api/budget?month=2026-10&x=1", { headers: await authed() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), month);
    assert.equal(projections.seen[0]?.url, "/internal/budget?month=2026-10");
    await call("/api/budget", { headers: await authed() });
    const second = projections.seen[1];
    assert.equal(second?.url, "/internal/budget");
    assert.equal(second.headers.authorization, undefined);
  });

  test("a bad month gives 400 with no upstream call", async () => {
    const call = await start();
    for (const query of ["month=2026-13", "month=2026-1", "month=x"]) {
      assert.equal((await call(`/api/budget?${query}`, { headers: await authed() })).status, 400);
    }
    assert.equal(projections.seen.length, 0);
  });

  test("404 from projections passes through; a bad answer gives 502", async () => {
    const call = await start();
    projections.set((seen, response) => {
      json(
        response,
        404,
        {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "not_found",
          detail: "No cap is set and the month has no spend",
          instance: seen.url,
        },
        "application/problem+json",
      );
    });
    const missing = await call("/api/budget", { headers: await authed() });
    assert.equal(missing.status, 404);
    const body = await problemOf(missing);
    assert.equal(body.code, "not_found");
    assert.equal(body.instance, "/api/budget");
    projections.set((_seen, response) => {
      json(response, 200, { ...month, capMicroUsd: -1 });
    });
    assert.equal((await call("/api/budget", { headers: await authed() })).status, 502);
  });
});

describe("POST /api/budget", () => {
  const cap = { scope: { kind: "month" }, hardCapMicroUsd: 5_000_000, softCapMicroUsd: 4_000_000 };
  const SetBudgetBody = CommandEnvelopeV1(SetBudgetCommandPayloadV1).extend({
    type: z.literal("budget.SetBudget"),
  });

  test("forwards SetBudget with the owner token to a budget service that checks it", async () => {
    const versions = new Map<string, number>();
    const tokens: (string | undefined)[] = [];
    const upstream = createService({
      logger,
      drainDelayMs: 0,
      before: [
        (request) => {
          tokens.push(request.headers.authorization);
        },
        bearerHook(
          createJwtVerifier({ issuer, audience: "ai-systems-app", requiredRole: "owner", jwksUrl }),
        ),
      ],
      routes: [
        {
          method: "POST",
          path: "/internal/commands/set-budget",
          handler: async (request) => {
            const { body } = await validate(request, { body: SetBudgetBody });
            if (body.actor.id !== subjectOf(request).sub) throw new ForbiddenError();
            if (body.payload.scope.kind !== "month") {
              throw new ValidationError("The request is not valid", [
                { path: "payload.scope.kind", code: "invalid_value", message: "month only" },
              ]);
            }
            const known = versions.get(body.commandId);
            const version = known ?? versions.size + 1;
            versions.set(body.commandId, version);
            return { status: known ? 200 : 201, body: { version } };
          },
        },
      ],
    });
    services.push(upstream);
    const { port } = await upstream.listen(0, "127.0.0.1");
    const call = await start({ budgetUrl: `http://127.0.0.1:${String(port)}` });
    const key = randomUUID();
    const request = await submit(cap, key);
    const first = await call("/api/budget", request);
    const again = await call("/api/budget", request);
    assert.equal(first.status, 202);
    assert.equal(again.status, 202);
    assert.deepEqual(await first.json(), { version: 1 });
    assert.deepEqual(await again.json(), { version: 1 });
    const sent = request.headers.authorization;
    assert.deepEqual(tokens, [sent, sent]);

    const project = await call(
      "/api/budget",
      await submit({ scope: { kind: "project", key: randomUUID() }, hardCapMicroUsd: 1 }),
    );
    assert.equal(project.status, 400);
    const problem = (await problemOf(project)) as unknown as {
      instance: string;
      errors: { path: string }[];
    };
    assert.equal(problem.instance, "/api/budget");
    assert.deepEqual(
      problem.errors.map((issue) => issue.path),
      ["payload.scope.kind"],
    );
  });

  test("sends the command body; only the owner command routes forward the token", async () => {
    budget.set((_seen, response) => {
      json(response, 201, { version: 3 });
    });
    const call = await start();
    const key = randomUUID();
    const correlationId = randomUUID();
    const request = await submit(cap, key, { "x-correlation-id": correlationId });
    const response = await call("/api/budget", request);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { version: 3 });
    const sent = budget.seen[0];
    assert.ok(sent);
    assert.equal(sent.url, "/internal/commands/set-budget");
    assert.equal(sent.headers.authorization, request.headers.authorization);
    assert.equal(sent.headers["x-correlation-id"], correlationId);
    assert.deepEqual(sent.body, {
      commandId: key,
      type: "budget.SetBudget",
      actor: { kind: "owner", id: "owner-1" },
      payload: cap,
    });
    replaying();
    await call("/api/tasks", await submit({ text: "Write a poem" }));
    assert.equal(orchestration.seen[0]?.headers.authorization, undefined);
    projections.set((_seen, response) => {
      json(response, 200, empty);
    });
    assert.equal((await call("/api/agents", { headers: await authed() })).status, 200);
    const listed = projections.seen[0];
    assert.ok(listed);
    assert.equal(listed.url, "/internal/agents");
    assert.equal(listed.headers.authorization, undefined);
  });

  test("a bad key or body gives 400 with no upstream call", async () => {
    const call = await start();
    const noKey = await call("/api/budget", {
      method: "POST",
      headers: await authed({ "content-type": "application/json" }),
      body: JSON.stringify(cap),
    });
    assert.equal(noKey.status, 400);
    const cases: [unknown, string][] = [
      [{}, "body.scope"],
      [{ ...cap, hardCapMicroUsd: 1.5 }, "body.hardCapMicroUsd"],
      [{ ...cap, hardCapMicroUsd: -1 }, "body.hardCapMicroUsd"],
      [{ ...cap, hardCapMicroUsd: 1_000_000_000_001 }, "body.hardCapMicroUsd"],
      [{ ...cap, softCapMicroUsd: 6_000_000 }, "body.softCapMicroUsd"],
      [{ ...cap, scope: { kind: "month", key: "2026-10" } }, "body.scope.key"],
      [{ ...cap, scope: { kind: "year" } }, "body.scope.kind"],
    ];
    for (const [body, issuePath] of cases) {
      const response = await call("/api/budget", await submit(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      const problem = (await problemOf(response)) as unknown as { errors: { path: string }[] };
      assert.ok(
        problem.errors.some((issue) => issue.path === issuePath),
        `${issuePath} ${JSON.stringify(problem.errors)}`,
      );
    }
    assert.equal(budget.seen.length, 0);
  });

  test("400, 403 and 409 from budget pass through; other answers give 502 or 503", async () => {
    const call = await start();
    for (const [status, code] of [
      [400, "validation_failed"],
      [403, "forbidden"],
      [409, "conflict"],
    ] as const) {
      budget.set((_seen, response) => {
        json(
          response,
          status,
          { type: "about:blank", title: "No", status, code },
          "application/problem+json",
        );
      });
      const response = await call("/api/budget", await submit(cap));
      assert.equal(response.status, status);
      const problem = await problemOf(response);
      assert.equal(problem.code, code);
      assert.equal(problem.instance, "/api/budget");
    }
    const bad: Behaviour[] = [
      (_seen, response) => {
        json(response, 401, {
          type: "about:blank",
          title: "No",
          status: 401,
          code: "unauthorized",
        });
      },
      (_seen, response) => {
        json(response, 503, { type: "about:blank", title: "No", status: 503, code: "unavailable" });
      },
      (_seen, response) => {
        json(response, 201, { version: 0 });
      },
      (_seen, response) => response.writeHead(201).end("not json"),
    ];
    for (const answer of bad) {
      budget.set(answer);
      const response = await call("/api/budget", await submit(cap));
      assert.equal(response.status, 502);
      assert.equal((await problemOf(response)).code, "unavailable");
    }
    const closed = createServer();
    const url = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const down = await start({ budgetUrl: url });
    const response = await down("/api/budget", await submit(cap));
    assert.equal(response.status, 503);
  });

  test("the route needs the owner role", async () => {
    const call = await start();
    const response = await call("/api/budget", {
      ...(await submit(cap)),
      headers: {
        authorization: `Bearer ${await sign({ realm_access: { roles: [] } })}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
    });
    assert.equal(response.status, 403);
    assert.equal(budget.seen.length, 0);
  });
});

describe("POST /api/tasks/:id/<control>", () => {
  const taskId = randomUUID();
  const subtaskId = randomUUID();
  const checkpointId = randomUUID();
  const subtasks = [
    {
      subtaskId,
      title: "Facts",
      instructions: "Find the facts.",
      agentId: randomUUID(),
      dependsOn: [],
      needsApproval: false,
    },
  ];
  const controls: [string, string, Record<string, unknown>][] = [
    ["approve-plan", "ApprovePlan", { planVersion: 2 }],
    ["edit-plan", "EditPlan", { planVersion: 1, subtasks }],
    ["reject-plan", "RejectPlan", { planVersion: 1, reason: "Too long." }],
    ["pause-run", "PauseRun", {}],
    ["resume-run", "ResumeRun", {}],
    ["cancel-run", "CancelRun", { reason: "Not needed." }],
    ["cancel-task", "CancelTask", {}],
    ["retry-subtask", "RetrySubtask", { subtaskId }],
    [
      "reassign-subtask",
      "ReassignSubtask",
      { subtaskId, agentId: randomUUID(), model: "openai/gpt-4.1-nano" },
    ],
    ["set-task-mode", "SetTaskMode", { mode: "auto" }],
    ["resolve-checkpoint", "ResolveCheckpoint", { checkpointId, decision: "approved" }],
  ];
  const accepting = () => {
    orchestration.set((seen, response) => {
      const { payload } = seen.body as { payload: { taskId: string } };
      json(response, 201, { taskId: payload.taskId, version: 7 });
    });
  };

  test("forwards each control to orchestration with the owner token and the task id of the path", async () => {
    accepting();
    const call = await start();
    for (const [path, name, body] of controls) {
      orchestration.seen.length = 0;
      const key = randomUUID();
      const correlationId = randomUUID();
      const request = await submit({ ...body, taskId: randomUUID() }, key, {
        "x-correlation-id": correlationId,
      });
      const response = await call(`/api/tasks/${taskId}/${path}`, request);
      assert.equal(response.status, 202, path);
      assert.deepEqual(await response.json(), { taskId, version: 7 });
      const sent = orchestration.seen[0];
      assert.ok(sent);
      assert.equal(sent.url, `/internal/commands/${path}`);
      assert.equal(sent.headers.authorization, request.headers.authorization);
      assert.equal(sent.headers["x-correlation-id"], correlationId);
      assert.deepEqual(sent.body, {
        commandId: key,
        type: `orchestration.${name}`,
        actor: { kind: "owner", id: "owner-1" },
        payload: { ...body, taskId },
      });
    }
  });

  test("the token goes only to the owner command routes, not to submit-task or projections", async () => {
    accepting();
    const call = await start();
    assert.equal((await call(`/api/tasks/${taskId}/pause-run`, await submit({}))).status, 202);
    replaying();
    assert.equal((await call("/api/tasks", await submit({ text: "Write" }))).status, 202);
    const [paused, submitted] = orchestration.seen;
    assert.ok(paused && submitted);
    assert.match(paused.headers.authorization ?? "", /^Bearer /);
    assert.equal(submitted.url, "/internal/commands/submit-task");
    assert.equal(submitted.headers.authorization, undefined);
    projections.set((_seen, response) => {
      json(response, 404, { type: "about:blank", title: "No", status: 404, code: "not_found" });
    });
    assert.equal((await call(`/api/tasks/${taskId}`, { headers: await authed() })).status, 404);
    assert.equal(projections.seen[0]?.headers.authorization, undefined);
  });

  test("an orchestration that checks the token: 201 and 200 give 202, 403 and 409 pass through", async () => {
    const versions = new Map<string, number>();
    const upstream = createService({
      logger,
      drainDelayMs: 0,
      before: [
        bearerHook(
          createJwtVerifier({ issuer, audience: "ai-systems-app", requiredRole: "owner", jwksUrl }),
        ),
      ],
      routes: [
        {
          method: "POST",
          path: "/internal/commands/pause-run",
          handler: async (request) => {
            const { body } = await validate(request, {
              body: CommandEnvelopeV1(z.object({ taskId: z.string() })),
            });
            if (body.actor.id !== subjectOf(request).sub) throw new ForbiddenError();
            if (versions.size > 0 && !versions.has(body.commandId)) {
              throw new ConflictError("The run is not running.");
            }
            const known = versions.get(body.commandId);
            versions.set(body.commandId, 3);
            return { status: known ? 200 : 201, body: { taskId: body.payload.taskId, version: 3 } };
          },
        },
      ],
    });
    services.push(upstream);
    const { port } = await upstream.listen(0, "127.0.0.1");
    const call = await start({ orchestrationUrl: `http://127.0.0.1:${String(port)}` });
    const request = await submit({}, randomUUID());
    const first = await call(`/api/tasks/${taskId}/pause-run`, request);
    const again = await call(`/api/tasks/${taskId}/pause-run`, request);
    assert.equal(first.status, 202);
    assert.equal(again.status, 202);
    assert.deepEqual(await again.json(), { taskId, version: 3 });
    const conflict = await call(`/api/tasks/${taskId}/pause-run`, await submit({}));
    assert.equal(conflict.status, 409);
    const problem = (await problemOf(conflict)) as unknown as { detail: string; instance: string };
    assert.equal(problem.detail, "The run is not running.");
    assert.equal(problem.instance, `/api/tasks/${taskId}/pause-run`);
  });

  test("an edit near the plan limit of 200,000 bytes reaches orchestration in full", async () => {
    accepting();
    const call = await start();
    const big = Array.from({ length: 20 }, () => ({
      ...subtasks[0],
      subtaskId: randomUUID(),
      title: "t".repeat(200),
      instructions: "\u00e9".repeat(4000),
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length;
    assert.ok(bytes > 150_000 && bytes <= 200_000, String(bytes));
    const response = await call(
      `/api/tasks/${taskId}/edit-plan`,
      await submit({ planVersion: 1, subtasks: big }),
    );
    assert.equal(response.status, 202);
    const sent = orchestration.seen[0]?.body as { payload: { subtasks: unknown[] } };
    assert.deepEqual(sent.payload.subtasks, big);
  });

  test("a bad key, id or body gives 400 with no upstream call", async () => {
    const call = await start();
    const noKey = await call(`/api/tasks/${taskId}/approve-plan`, {
      method: "POST",
      headers: await authed({ "content-type": "application/json" }),
      body: JSON.stringify({ planVersion: 1 }),
    });
    assert.equal(noKey.status, 400);
    const cases: [string, string, unknown, string][] = [
      [taskId, "approve-plan", {}, "body.planVersion"],
      [taskId, "approve-plan", { planVersion: 0 }, "body.planVersion"],
      ["not-a-uuid", "pause-run", {}, "params.id"],
      [taskId, "edit-plan", { planVersion: 1, subtasks: [] }, "body.subtasks"],
      [taskId, "reject-plan", { planVersion: 1 }, "body.reason"],
      [taskId, "retry-subtask", { subtaskId: "x" }, "body.subtaskId"],
      [taskId, "set-task-mode", { mode: "fast" }, "body.mode"],
      [taskId, "resolve-checkpoint", { checkpointId, decision: "expired" }, "body.decision"],
    ];
    for (const [id, path, body, issuePath] of cases) {
      const response = await call(`/api/tasks/${id}/${path}`, await submit(body));
      assert.equal(response.status, 400, path);
      const problem = (await problemOf(response)) as unknown as { errors: { path: string }[] };
      assert.ok(
        problem.errors.some((issue) => issue.path === issuePath),
        `${issuePath} ${JSON.stringify(problem.errors)}`,
      );
    }
    assert.equal(orchestration.seen.length, 0);
  });

  test("400, 403, 404 and 409 pass through; other answers give 502 or 503", async () => {
    const call = await start();
    const path = `/api/tasks/${taskId}/cancel-run`;
    for (const [status, code] of [
      [400, "validation_failed"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
    ] as const) {
      orchestration.set((_seen, response) => {
        json(
          response,
          status,
          { type: "about:blank", title: "No", status, code },
          "application/problem+json",
        );
      });
      const response = await call(path, await submit({}));
      assert.equal(response.status, status);
      const problem = await problemOf(response);
      assert.equal(problem.code, code);
      assert.equal(problem.instance, path);
    }
    const bad: Behaviour[] = [
      (_seen, response) => {
        json(response, 401, {
          type: "about:blank",
          title: "No",
          status: 401,
          code: "unauthorized",
        });
      },
      (_seen, response) => {
        json(response, 503, { type: "about:blank", title: "No", status: 503, code: "unavailable" });
      },
      (_seen, response) => {
        json(response, 201, { taskId: randomUUID(), version: 2 });
      },
      (_seen, response) => {
        json(response, 201, { taskId, version: 0 });
      },
      (_seen, response) => response.writeHead(201).end("not json"),
    ];
    for (const answer of bad) {
      orchestration.set(answer);
      const response = await call(path, await submit({}));
      assert.equal(response.status, 502);
      assert.equal((await problemOf(response)).code, "unavailable");
    }
    const closed = createServer();
    const url = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const down = await start({ orchestrationUrl: url });
    assert.equal((await down(path, await submit({}))).status, 503);
  });

  test("the routes need the owner role and count for the rate limit", async () => {
    accepting();
    const call = await start({ rateLimit: { perSecond: 1, burst: 1, now: () => 9_000_000 } });
    const guest = await call(`/api/tasks/${taskId}/pause-run`, {
      ...(await submit({})),
      headers: {
        authorization: `Bearer ${await sign({ realm_access: { roles: [] } })}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
    });
    assert.equal(guest.status, 403);
    assert.equal(orchestration.seen.length, 0);
    assert.equal((await call(`/api/tasks/${taskId}/pause-run`, await submit({}))).status, 202);
    const limited = await call(`/api/tasks/${taskId}/resume-run`, await submit({}));
    assert.equal(limited.status, 429);
    assert.equal(orchestration.seen.length, 1);
  });
});

describe("GET /api/agents", () => {
  const agents = {
    items: [
      {
        agentId: "00000000-0000-4000-8000-00000000a001",
        name: "orchestrator",
        enabled: true,
        activeVersion: 1,
        latestVersion: 1,
        rev: 4,
        asOf: 4,
      },
    ],
    headSeq: 9,
  };

  test("gives the agent list from projections", async () => {
    projections.set((_seen, response) => {
      json(response, 200, agents);
    });
    const call = await start();
    const response = await call("/api/agents?limit=5", { headers: await authed() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), agents);
    assert.equal(projections.seen[0]?.url, "/internal/agents");
  });

  test("a 404 or a bad answer from projections gives 502", async () => {
    const call = await start();
    projections.set((seen, response) => {
      json(
        response,
        404,
        {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "not_found",
          instance: seen.url,
        },
        "application/problem+json",
      );
    });
    assert.equal((await call("/api/agents", { headers: await authed() })).status, 502);
    projections.set((_seen, response) => {
      json(response, 200, { items: [{ name: "x" }], headSeq: 1 });
    });
    assert.equal((await call("/api/agents", { headers: await authed() })).status, 502);
  });
});

describe("upstream body limit", () => {
  test("an answer over 1 MiB gives 502, with or without content-length", async () => {
    const call = await start();
    const big = JSON.stringify({ items: [], headSeq: 0, pad: "x".repeat(1024 * 1024) });
    projections.set((_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(big);
    });
    assert.equal((await call("/api/tasks", { headers: await authed() })).status, 502);
    projections.set((_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      for (let index = 0; index < 20; index += 1) response.write("x".repeat(64 * 1024));
      response.end();
    });
    assert.equal((await call("/api/tasks", { headers: await authed() })).status, 502);
    projections.set((_seen, response) => {
      json(response, 200, { items: [], headSeq: 0, pad: "x".repeat(1000 * 1024) });
    });
    assert.equal((await call("/api/tasks", { headers: await authed() })).status, 200);
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
    assert.equal(config.CONVERSATION_HUB_URL, "http://ai-systems-conversation-hub:8080");
    assert.equal(config.BUDGET_URL, "http://ai-systems-budget:8080");
    assert.equal(config.PORT, 8080);
    assert.throws(() =>
      loadConfig(Env, { ORCHESTRATION_URL: "file:///etc/passwd", PROJECTIONS_URL: "x" }),
    );
    assert.throws(() => loadConfig(Env, {}));
  });

  test("OIDC_JWKS_URL is the key source, the issuer check stays", async () => {
    const upstreams = {
      ORCHESTRATION_URL: "http://ai-systems-orchestration:8080",
      PROJECTIONS_URL: "http://ai-systems-projections:8080",
    };
    assert.equal(verifierOptions(loadConfig(Env, upstreams)).jwksUrl, undefined);
    const config = loadConfig(Env, { ...upstreams, OIDC_ISSUER: issuer, OIDC_JWKS_URL: jwksUrl });
    const options = verifierOptions(config);
    assert.equal(options.issuer, issuer);
    assert.equal(options.jwksUrl, jwksUrl);
    const verify = createJwtVerifier(options);
    assert.equal((await verify(await sign())).sub, "owner-1");
    await assert.rejects(
      verify(await sign({ iss: "https://other.example.test/realms/ai-systems" })),
    );
    assert.throws(() => loadConfig(Env, { ...upstreams, OIDC_JWKS_URL: "file:///etc/passwd" }));
  });
});
