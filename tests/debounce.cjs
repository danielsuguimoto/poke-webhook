const assert = require("node:assert/strict");
const { test } = require("node:test");
const { SlackDebounceBuffer, debounceWindowMs } = require("../.test-build/debounce.js");
const { composio } = require("../.test-build/sources/composio.js");

const DANIEL = "U01D45GTXRB";

function mockState() {
  const store = new Map();
  const alarms = [];
  return {
    alarms,
    storage: {
      get: async (key) => store.get(key),
      put: async (key, value) => { store.set(key, value); },
      deleteAll: async () => store.clear(),
      setAlarm: async (ts) => { alarms.length = 0; alarms.push(ts); },
      deleteAlarm: async () => { alarms.length = 0; },
    },
  };
}

function dmEvent(id, { user = "U777", channel = "D123", text = "hi" } = {}) {
  return {
    id,
    type: "composio.trigger.message",
    metadata: { log_id: `log-${id}`, trigger_slug: "SLACK_DIRECT_MESSAGE_RECEIVED" },
    data: { type: "message", channel, channel_type: "im", user, text },
    timestamp: "2026-10-27T12:00:00Z",
  };
}

// A SLACK_DM_BUFFER namespace backed by real SlackDebounceBuffer objects, one
// per conversation key (mirrors idFromName routing), over mock storage.
function fakeNamespace(env, instances = new Map()) {
  return {
    instances,
    idFromName: (name) => name,
    get: (key) => {
      if (!instances.has(key)) {
        const state = mockState();
        const obj = new SlackDebounceBuffer(state, env);
        instances.set(key, { obj, state });
      }
      const { obj } = instances.get(key);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
}

function dmEnv(extra = {}) {
  return { POKE_API_KEY: "k", SLACK_USER_ID: DANIEL, SLACK_DM_DEBOUNCE_SECONDS: "75", ...extra };
}

test("SlackDebounceBuffer appends, resets the quiet window and aggregates on alarm", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const state = mockState();
  const env = { POKE_API_KEY: "k" };
  const obj = new SlackDebounceBuffer(state, env);

  const append = (message, windowMs = 60_000) => obj.fetch(new Request("https://debounce.internal/append", {
    method: "POST", body: JSON.stringify({ message, windowMs }),
  }));

  const r1 = await append("first");
  assert.equal(r1.status, 202);
  assert.equal((await r1.json()).buffered, 1);
  const firstAlarm = state.alarms[0];

  const r2 = await append("second");
  assert.equal((await r2.json()).buffered, 2);
  // Each append resets the pending alarm (trailing-edge debounce).
  assert.equal(state.alarms.length, 1);
  assert.ok(state.alarms[0] >= firstAlarm);

  assert.equal(calls.length, 0);
  await obj.alarm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://poke.com/api/v1/inbound/api-message");
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.message.startsWith("[Composio] 2 mensagens diretas do Slack agregadas:"));
  assert.ok(body.message.includes("first"));
  assert.ok(body.message.includes("second"));
});

test("SlackDebounceBuffer cancel drops buffered messages and clears the alarm", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return Response.json({}); });
  const state = mockState();
  const obj = new SlackDebounceBuffer(state, { POKE_API_KEY: "k" });

  await obj.fetch(new Request("https://debounce.internal/append", {
    method: "POST", body: JSON.stringify({ message: "pending" }),
  }));
  assert.equal(state.alarms.length, 1);

  const res = await obj.fetch(new Request("https://debounce.internal/cancel", { method: "POST" }));
  assert.equal(res.status, 202);

  // A delayed alarm that fires after cancellation finds an empty buffer.
  await obj.alarm();
  assert.equal(calls.length, 0);
  assert.equal(state.alarms.length, 0);
});

test("SlackDebounceBuffer retries a failed Poke forward via alarm and drops after max attempts", async (t) => {
  const calls = [];
  let ok = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls.push(1);
    return ok ? Response.json({}) : new Response("boom", { status: 500 });
  });
  const state = mockState();
  const obj = new SlackDebounceBuffer(state, { POKE_API_KEY: "k" });

  await obj.fetch(new Request("https://debounce.internal/append", {
    method: "POST", body: JSON.stringify({ message: "only message" }),
  }));

  await obj.alarm();
  assert.equal(calls.length, 1);
  assert.equal(state.alarms.length, 1); // retry scheduled

  ok = true;
  await obj.alarm();
  assert.equal(calls.length, 2); // single message forwarded unwrapped on retry

  ok = false;
  await obj.fetch(new Request("https://debounce.internal/append", {
    method: "POST", body: JSON.stringify({ message: "doomed" }),
  }));
  for (let i = 0; i < 4; i++) await obj.alarm();
  assert.equal(calls.length, 2 + 4);
  // Buffer dropped after the retry budget; a later alarm is a no-op.
  await obj.alarm();
  assert.equal(calls.length, 2 + 4);
});

test("SlackDebounceBuffer rejects malformed appends", async () => {
  const obj = new SlackDebounceBuffer(mockState(), { POKE_API_KEY: "k" });
  for (const body of [null, {}, { message: 42 }, { message: "" }]) {
    const res = await obj.fetch(new Request("https://debounce.internal/append", {
      method: "POST", body: JSON.stringify(body),
    }));
    assert.equal(res.status, 400);
  }
  assert.equal((await obj.fetch(new Request("https://debounce.internal/other", { method: "POST" }))).status, 404);
});

test("debounceWindowMs honors SLACK_DM_DEBOUNCE_SECONDS and defaults to 60s", () => {
  assert.equal(debounceWindowMs({}), 60_000);
  assert.equal(debounceWindowMs({ SLACK_DM_DEBOUNCE_SECONDS: "90" }), 90_000);
  assert.equal(debounceWindowMs({ SLACK_DM_DEBOUNCE_SECONDS: "0" }), 60_000);
  assert.equal(debounceWindowMs({ SLACK_DM_DEBOUNCE_SECONDS: "junk" }), 60_000);
});

test("Composio buffers Slack DMs per conversation; alarm forwards the aggregated batch", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const env = dmEnv();
  env.SLACK_DM_BUFFER = fakeNamespace(env);
  const ctx = { waitUntil: () => {} };

  const r1 = await composio.handle(dmEvent("evt-dm-1"), env, ctx);
  assert.equal(r1.status, 202);
  assert.equal((await r1.json()).status, "buffered");
  const r2 = await composio.handle(dmEvent("evt-dm-2", { text: "segundo" }), env, ctx);
  assert.equal((await r2.json()).status, "buffered");
  assert.equal(calls.length, 0); // nothing forwarded before the quiet window

  const { obj } = env.SLACK_DM_BUFFER.instances.get("channel:D123");
  await obj.alarm();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.message.startsWith("[Composio] 2 mensagens diretas do Slack agregadas:"));
  assert.ok(body.message.includes("evt-dm-1"));
  assert.ok(body.message.includes("segundo"));
});

test("Composio: Daniel's own DM cancels only that conversation's pending buffer", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const env = dmEnv();
  env.SLACK_DM_BUFFER = fakeNamespace(env);
  const ctx = { waitUntil: () => {} };

  // Third-party messages buffer in two different conversations.
  assert.equal((await composio.handle(dmEvent("evt-c1", { channel: "D123" }), env, ctx)).status, 202);
  assert.equal((await composio.handle(dmEvent("evt-c2", { channel: "D456", user: "U555" }), env, ctx)).status, 202);

  // Daniel replies in D123: that buffer is cancelled, D456 is untouched.
  const res = await composio.handle(dmEvent("evt-c3", { user: DANIEL, channel: "D123", text: "on it" }), env, ctx);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, "ignored");

  await env.SLACK_DM_BUFFER.instances.get("channel:D123").obj.alarm();
  assert.equal(calls.length, 0); // cancelled batch never forwards

  await env.SLACK_DM_BUFFER.instances.get("channel:D456").obj.alarm();
  assert.equal(calls.length, 1); // the other conversation still flushes
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.message.includes("evt-c2"));
  assert.ok(!body.message.includes("evt-c1"));
});

test("Composio falls back to synchronous forwarding when SLACK_DM_BUFFER is unbound", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const res = await composio.handle(dmEvent("evt-nobuffer-1"), dmEnv(), { waitUntil: () => {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "accepted");
  assert.equal(calls.length, 1);
});

test("Composio: Daniel's DM without a buffer binding is still ignored", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return Response.json({}); });
  const res = await composio.handle(dmEvent("evt-self-1", { user: DANIEL }), dmEnv(), { waitUntil: () => {} });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, "ignored");
  assert.equal(calls.length, 0);
});

test("Composio returns 503 when the debounce buffer append fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const env = dmEnv();
  env.SLACK_DM_BUFFER = {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
  };
  const res = await composio.handle(dmEvent("evt-append-fail-1"), env, { waitUntil: () => {} });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "debounce_buffer_failed");
});
