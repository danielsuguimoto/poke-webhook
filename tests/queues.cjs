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
