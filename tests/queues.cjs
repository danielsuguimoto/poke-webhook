const assert = require("node:assert/strict");
const { test } = require("node:test");
const worker = require("../.test-build/index.js").default;

const ENV = { POKE_API_KEY: "test-poke-key" };
const LOCATION_EVENT = {
  source: "location-tracker",
  type: "enter",
  data: {
    event: "enter",
    geofence: { id: "fence-1", name: "home", lat: -23.5, lon: -46.6, radius_m: 200 },
    location: null,
    message: 'Jun arrived at "home"',
    timestamp: 1700000000,
  },
  timestamp: "2023-11-14T22:13:20.000Z",
};
const RAMBLE_EVENT = {
  source: "ramble",
  type: "transcription.completed",
  data: { recording_id: "test-queue-rec-1", transcription: "olá" },
};
const CLOUDFLARE_EVENT = {
  type: "cf.workersBuilds.worker.build.succeeded",
  source: { type: "workersBuilds.worker", workerName: "my-worker" },
  payload: {
    buildUuid: "build-12345678-90ab-cdef-1234-567890abcdef",
    status: "success",
    buildOutcome: "success",
    createdAt: "2025-05-01T02:48:57.132Z",
    initializingAt: "2025-05-01T02:48:58.132Z",
    runningAt: "2025-05-01T02:48:59.132Z",
    stoppedAt: "2025-05-01T02:50:15.132Z",
    buildTriggerMetadata: {
      buildTriggerSource: "push_event",
      branch: "main",
      commitHash: "abc123def456",
      commitMessage: "Fix bug in authentication",
      author: "developer@example.com",
      buildCommand: "npm run build",
      deployCommand: "wrangler deploy",
      rootDirectory: "/",
      repoName: "my-worker-repo",
      providerAccountName: "github-user",
      providerType: "github",
    },
  },
  metadata: {
    accountId: "f9f79265f388666de8122cfb508d7776",
    eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
    eventSchemaVersion: 1,
    eventTimestamp: "2025-05-01T02:48:57.132Z",
  },
};

function makeMessage(body, i = 0) {
  const state = { value: "pending" };
  return {
    id: `msg-${i}`,
    timestamp: new Date(1700000000 * 1000),
    attempts: 1,
    body,
    state,
    ack() { state.value = "ack"; },
    retry() { state.value = "retry"; },
  };
}

function makeBatch(bodies, queue = "poke-webhook-events") {
  const calls = { ackAll: 0, retryAll: 0 };
  const messages = bodies.map((body, i) => makeMessage(body, i));
  const batch = {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll() { calls.ackAll++; },
    retryAll() { calls.retryAll++; },
  };
  return { batch, messages, calls };
}

async function invoke(bodies, options = {}) {
  const { batch, messages, calls } = makeBatch(bodies, options.queue);
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  await worker.queue(batch, { ...ENV, ...options.env }, ctx);
  return { messages, calls, pending };
}

test("queue consumer dispatches structured events to their source handler and acks", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const { messages, calls: batchCalls, pending } = await invoke([LOCATION_EVENT]);
  assert.equal(messages[0].state.value, "ack");
  assert.equal(batchCalls.ackAll, 1);
  assert.equal(batchCalls.retryAll, 0);
  await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://poke.com/api/v1/inbound/api-message");
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.message, /^\[Location Tracker\] Entrada na área "home":/);
});

test("queue consumer accepts JSON string bodies and ignores the envelope timestamp", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const { messages, calls: batchCalls, pending } = await invoke([JSON.stringify({ ...LOCATION_EVENT, timestamp: 1700000000 })]);
  assert.equal(messages[0].state.value, "ack");
  assert.equal(batchCalls.ackAll, 1);
  await Promise.all(pending);
  assert.equal(calls.length, 1);
});

test("queue consumer retries messages whose handler returns a retryable 5xx", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("poke down", { status: 503 }));
  const { messages, calls } = await invoke([RAMBLE_EVENT]);
  assert.equal(messages[0].state.value, "retry");
  assert.equal(calls.ackAll, 1);
});

test("queue consumer acks malformed messages and unknown sources without forwarding", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward malformed or unroutable messages"));
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const malformed = [
    "not json",
    "{unclosed",
    null,
    [],
    {},
    { source: "location-tracker" },
    { type: "enter", data: {} },
    { source: 1, type: "enter", data: {} },
    { source: "location-tracker", type: "enter" },
    { source: "location-tracker", type: "enter", data: [] },
    { source: "location-tracker", type: "enter", data: {}, timestamp: {} },
  ];
  const unknownSource = { source: "no-such-source", type: "anything", data: {} };
  const { messages, calls } = await invoke([...malformed, unknownSource]);
  assert.deepEqual(messages.map((m) => m.state.value), malformed.map(() => "ack").concat("ack"));
  assert.equal(calls.ackAll, 1);
  assert.equal(errors.length, malformed.length + 1);
});

test("queue consumer drops events whose handler rejects with 4xx instead of retrying", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward rejected events"));
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const invalidLocation = { ...LOCATION_EVENT, data: { ...LOCATION_EVENT.data, geofence: {} } };
  const { messages } = await invoke([invalidLocation]);
  assert.equal(messages[0].state.value, "ack");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /handler returned 400/);
});

test("queue consumer handles mixed batches independently and retries handler exceptions", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const { QUEUE_DISPATCHERS } = require("../.test-build/queue.js");
  QUEUE_DISPATCHERS["throw-queue"] = async (event) => {
    if (event.source === "exploding-source") throw new Error("dispatcher exploded");
    return "ack";
  };
  try {
    const exploding = { source: "exploding-source", type: "boom", data: {} };
    const { messages, calls: batchCalls, pending } = await invoke([LOCATION_EVENT, exploding, "garbage"], { queue: "throw-queue" });
    assert.deepEqual(messages.map((m) => m.state.value), ["ack", "retry", "ack"]);
    assert.equal(batchCalls.ackAll, 1);
    await Promise.all(pending);
    assert.equal(calls.length, 0);
  } finally {
    delete QUEUE_DISPATCHERS["throw-queue"];
  }
});

test("queue consumer retries when a background Poke forward resolves false", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("poke down", { status: 503 }));
  const { messages, pending } = await invoke([LOCATION_EVENT]);
  await Promise.allSettled(pending);
  assert.equal(messages[0].state.value, "retry");
});

test("queue consumer acks events for inherited object property names", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward unroutable messages"));
  for (const source of ["toString", "hasOwnProperty", "constructor", "valueOf", "__proto__"]) {
    const { messages } = await invoke([{ source, type: "anything", data: {} }]);
    assert.equal(messages[0].state.value, "ack", source);
  }
});

test("queue consumer redelivery of a deduplicated source forwards after a failed attempt", async (t) => {
  let pokeAttempts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("agent.tinyfish.ai")) return Response.json({ status: "COMPLETED" });
    pokeAttempts++;
    return pokeAttempts === 1 ? new Response("poke down", { status: 503 }) : Response.json({});
  });
  const tinyfishEvent = {
    source: "tinyfish",
    type: "run.completed",
    data: { event: "run.completed", run_id: "run-dedup-1", data: {} },
  };
  const env = { TINYFISH_API_KEY: "test-tinyfish-key" };
  const first = await invoke([tinyfishEvent], { env });
  assert.equal(first.messages[0].state.value, "retry");
  const second = await invoke([tinyfishEvent], { env });
  assert.equal(second.messages[0].state.value, "ack");
  assert.equal(pokeAttempts, 2);
  const third = await invoke([tinyfishEvent], { env });
  assert.equal(third.messages[0].state.value, "ack");
  assert.equal(pokeAttempts, 2);
});

test("queue consumer routes batches by queue name through the dispatch registry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const { QUEUE_DISPATCHERS } = require("../.test-build/queue.js");
  const seen = [];
  QUEUE_DISPATCHERS["custom-queue"] = async (event) => { seen.push(event); return "ack"; };
  try {
    const { messages } = await invoke([LOCATION_EVENT], { queue: "custom-queue" });
    assert.equal(messages[0].state.value, "ack");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, "location-tracker");
  } finally {
    delete QUEUE_DISPATCHERS["custom-queue"];
  }
});

test("queue consumer forwards native Cloudflare build events without a custom envelope", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const original = structuredClone(CLOUDFLARE_EVENT);
  const { messages } = await invoke([CLOUDFLARE_EVENT, JSON.stringify(CLOUDFLARE_EVENT)]);
  assert.deepEqual(messages.map((m) => m.state.value), ["ack", "ack"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(CLOUDFLARE_EVENT, original);
  for (const call of calls) {
    assert.equal(call.url, "https://poke.com/api/v1/inbound/api-message");
    assert.equal(call.options.headers.Authorization, "Bearer test-poke-key");
    assert.match(JSON.parse(call.options.body).message, /^\[Cloudflare\] Build concluído com sucesso/);
  }
});

test("queue consumer preserves native Cloudflare source, payload and metadata during normalization", async () => {
  const { QUEUE_DISPATCHERS } = require("../.test-build/queue.js");
  const seen = [];
  QUEUE_DISPATCHERS["native-queue"] = async (event) => { seen.push(event); return "ack"; };
  try {
    const { messages } = await invoke([CLOUDFLARE_EVENT], { queue: "native-queue" });
    assert.equal(messages[0].state.value, "ack");
    assert.deepEqual(seen, [{
      source: "cloudflare",
      type: CLOUDFLARE_EVENT.type,
      data: CLOUDFLARE_EVENT,
      timestamp: CLOUDFLARE_EVENT.metadata.eventTimestamp,
    }]);
  } finally {
    delete QUEUE_DISPATCHERS["native-queue"];
  }
});

for (const [kind, status, outcome, title] of [
  ["started", "running", null, "Build iniciado"],
  ["succeeded", "success", "success", "Build concluído com sucesso"],
  ["failed", "failed", "failure", "Falha no build"],
  ["canceled", "canceled", "canceled", "Build cancelado"],
]) {
  test(`native Cloudflare build.${kind} gets a Portuguese summary and preserves the full event`, async (t) => {
    const event = structuredClone(CLOUDFLARE_EVENT);
    event.type = `cf.workersBuilds.worker.build.${kind}`;
    Object.assign(event.payload, { status, buildOutcome: outcome });
    if (kind === "started") event.payload.stoppedAt = null;
    let message;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      message = JSON.parse(options.body).message;
      return Response.json({});
    });
    const { messages } = await invoke([event]);
    assert.equal(messages[0].state.value, "ack");
    assert.equal(message, [
      `[Cloudflare] ${title}`,
      "Worker: my-worker",
      `ID do build: ${event.payload.buildUuid}`,
      `Status: ${status}`,
      ...(outcome ? [`Resultado: ${outcome}`] : []),
      "Repositório: my-worker-repo",
      "Conta do repositório: github-user",
      "Branch: main",
      "Commit: abc123def456",
      "Mensagem do commit: Fix bug in authentication",
      "Autor: developer@example.com",
      "Data e hora: 2025-05-01T02:48:57.132Z",
      "", "Dados do evento:", JSON.stringify(event, null, 2),
    ].join("\n"));
  });
}

for (const [source, type, payload] of [
  [{ type: "r2" }, "cf.r2.bucket.created", { name: "my-bucket", jurisdiction: "default", location: "WNAM", storageClass: "Standard" }],
  [{ type: "kv" }, "cf.kv.namespace.created", { id: "namespace-1", title: "My namespace" }],
  [{ type: "workersBuilds.worker", workerName: "my-worker" }, "cf.workersBuilds.worker.build.queued", { buildUuid: "build-queued" }],
  [{ type: "future.product", resourceId: "resource-1" }, "cf.future.product.deployed", { deploymentUrl: "https://example.com", details: { result: "Keep in English" } }],
]) {
  test(`native ${type} uses the generic Cloudflare summary rather than being dropped`, async (t) => {
    const event = { type, source, payload, metadata: CLOUDFLARE_EVENT.metadata };
    let message;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      message = JSON.parse(options.body).message;
      return Response.json({});
    });
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args));
    const { messages } = await invoke([JSON.stringify(event)]);
    assert.equal(messages[0].state.value, "ack");
    assert.equal(errors.length, 0);
    assert.equal(message, [
      `[Cloudflare] Evento: ${type}`,
      `Data e hora: ${event.metadata.eventTimestamp}`,
      "", "Dados do evento:", JSON.stringify(event, null, 2),
    ].join("\n"));
  });
}

test("Cloudflare summary tolerates absent optional build details and preserves extra fields", async (t) => {
  const event = {
    ...CLOUDFLARE_EVENT,
    source: { type: "workersBuilds.worker" },
    payload: { buildUuid: "build-minimal", buildTriggerMetadata: null, extra: { url: "https://example.com", error: "Original error" } },
    metadata: { accountId: "account-1", eventSchemaVersion: 2 },
  };
  let message;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    message = JSON.parse(options.body).message;
    return Response.json({});
  });
  const { messages } = await invoke([event]);
  assert.equal(messages[0].state.value, "ack");
  assert.equal(message, [
    "[Cloudflare] Build concluído com sucesso", "ID do build: build-minimal",
    "", "Dados do evento:", JSON.stringify(event, null, 2),
  ].join("\n"));
});

test("queue consumer drops malformed native Cloudflare envelopes without forwarding", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward malformed native messages"));
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const malformed = [
    { ...CLOUDFLARE_EVENT, type: "build.succeeded" },
    { ...CLOUDFLARE_EVENT, type: "cf.workersBuilds.worker." },
    { ...CLOUDFLARE_EVENT, type: null },
    { ...CLOUDFLARE_EVENT, source: null },
    { ...CLOUDFLARE_EVENT, source: [] },
    { ...CLOUDFLARE_EVENT, source: {} },
    { ...CLOUDFLARE_EVENT, source: { type: "" } },
    { ...CLOUDFLARE_EVENT, source: { type: 1 } },
    { ...CLOUDFLARE_EVENT, source: { type: "r2" } },
    { ...CLOUDFLARE_EVENT, payload: undefined },
    { ...CLOUDFLARE_EVENT, payload: null },
    { ...CLOUDFLARE_EVENT, payload: [] },
    { ...CLOUDFLARE_EVENT, metadata: undefined },
    { ...CLOUDFLARE_EVENT, metadata: null },
    { ...CLOUDFLARE_EVENT, metadata: [] },
    { ...CLOUDFLARE_EVENT, metadata: { eventTimestamp: 42 } },
  ];
  const { messages, calls } = await invoke(malformed);
  assert.deepEqual(messages.map((m) => m.state.value), malformed.map(() => "ack"));
  assert.equal(calls.ackAll, 1);
  assert.equal(errors.length, malformed.length);
  for (const error of errors) assert.match(error[0], /dropping malformed message/);
});

test("queue consumer handles native and legacy messages independently and redelivers failed builds", async (t) => {
  let nativeAttempts = 0;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const message = JSON.parse(options.body).message;
    calls.push(message);
    if (message.startsWith("[Cloudflare]") && ++nativeAttempts === 1) return new Response("unavailable", { status: 503 });
    return Response.json({});
  });
  const { messages, calls: batchCalls } = await invoke([CLOUDFLARE_EVENT, LOCATION_EVENT, "garbage"]);
  assert.deepEqual(messages.map((m) => m.state.value), ["retry", "ack", "ack"]);
  assert.equal(batchCalls.ackAll, 1);
  const second = await invoke([CLOUDFLARE_EVENT]);
  assert.equal(second.messages[0].state.value, "ack");
  assert.equal(nativeAttempts, 2);
  assert.equal(calls.length, 3);
});

test("queue consumer waits for native Cloudflare forwarding before acknowledging", async (t) => {
  let finish;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { finish = resolve; }));
  const { batch, messages, calls } = makeBatch([CLOUDFLARE_EVENT]);
  const result = worker.queue(batch, ENV, { waitUntil() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[0].state.value, "pending");
  assert.equal(calls.ackAll, 0);
  finish(Response.json({}));
  await result;
  assert.equal(messages[0].state.value, "ack");
  assert.equal(calls.ackAll, 1);
});

test("queue consumer retries native events on network errors or missing Poke credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network down"); });
  const first = await invoke([CLOUDFLARE_EVENT]);
  assert.equal(first.messages[0].state.value, "retry");
  const second = await invoke([CLOUDFLARE_EVENT], { env: { POKE_API_KEY: "" } });
  assert.equal(second.messages[0].state.value, "retry");
});

test("Cloudflare source also accepts native data inside an existing custom queue envelope", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body).message);
    return Response.json({});
  });
  const { messages } = await invoke([{ source: "cloudflare", type: CLOUDFLARE_EVENT.type, data: CLOUDFLARE_EVENT }]);
  assert.equal(messages[0].state.value, "ack");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\[Cloudflare\] Build concluído com sucesso/);
});

test("Cloudflare source rejects invalid native data inside custom envelopes", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward invalid native data"));
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const { messages } = await invoke([{ source: "cloudflare", type: CLOUDFLARE_EVENT.type, data: {} }]);
  assert.equal(messages[0].state.value, "ack");
  assert.match(errors[0][0], /handler returned 400/);
});

test("Cloudflare is queue-only and cannot be spoofed through an unauthenticated HTTP request", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward HTTP Cloudflare events"));
  const response = await worker.fetch(new Request("https://worker.test/cloudflare", {
    method: "POST", body: JSON.stringify(CLOUDFLARE_EVENT),
  }), ENV, { waitUntil() {} });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "queue_only_source" });
});
