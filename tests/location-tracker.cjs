const assert = require("node:assert/strict");
const { test } = require("node:test");
const worker = require("../.test-build/index.js").default;

// Matches location-tracker's buildEventPayload; timestamps are Unix seconds.
const PAYLOAD = {
  event: "enter",
  geofence: { id: "fence-1", name: "home", lat: -23.5, lon: -46.6, radius_m: 200 },
  location: { lat: -23.501, lon: -46.601, acc: 5, tst: 1699999990, device: "JJ" },
  message: 'Jun arrived at "home"',
  timestamp: 1700000000,
};

async function invoke(payload = PAYLOAD, options = {}) {
  const pending = [];
  const headers = { "Content-Type": "application/json" };
  const authorization = options.authorization === undefined ? "Bearer test-location-secret" : options.authorization;
  if (authorization !== null) headers.Authorization = authorization;
  const response = await worker.fetch(new Request(`https://worker.example${options.path || "/location-tracker"}`, {
    method: options.method || "POST",
    headers,
    ...(options.method === "GET" ? {} : { body: options.rawBody ?? JSON.stringify(payload) }),
  }), {
    POKE_API_KEY: "test-poke-key",
    LOCATION_TRACKER_WEBHOOK_SECRET: "test-location-secret",
    ...options.env,
  }, { waitUntil: (promise) => pending.push(promise) });
  return { response, pending };
}

test("Location Tracker route forwards enter/exit activities with source text and UTC timestamps", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  for (const [event, title, sourceMessage] of [
    ["enter", "Entrada na área", 'Jun arrived at "home"'],
    ["exit", "Saída da área", 'Jun left "home"'],
  ]) {
    const payload = { ...structuredClone(PAYLOAD), event, message: sourceMessage };
    const original = structuredClone(payload);
    const { response, pending } = await invoke(payload);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "accepted", event_type: event, event_id: "fence-1" });
    assert.equal(pending.length, 1);
    assert.deepEqual(await Promise.all(pending), [true]);
    const { url, options } = calls.at(-1);
    assert.equal(url, "https://poke.com/api/v1/inbound/api-message");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, { Authorization: "Bearer test-poke-key", "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(options.body), { message: [
      `[Location Tracker] ${title} "home":`,
      `Evento: ${event}`,
      "ID da área: fence-1",
      "Centro da área: -23.5, -46.6 — Raio: 200 m",
      "Data e hora do evento: 2023-11-14T22:13:20.000Z",
      `Mensagem: ${sourceMessage}`,
      "Localização: -23.501, -46.601",
      "Precisão: 5 m",
      "Dispositivo: JJ",
      "Data e hora da localização: 2023-11-14T22:13:10.000Z",
    ].join("\n") });
    assert.deepEqual(payload, original);
  }
  assert.equal(calls.length, 2);
});

test("Location Tracker forwards tests with or without location without claiming actual movement", async (t) => {
  const messages = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    messages.push(JSON.parse(options.body).message);
    return Response.json({});
  });
  for (const location of [null, PAYLOAD.location]) {
    const { response, pending } = await invoke({ ...PAYLOAD, event: "test", location, message: 'Test notification for "home"' });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    const message = messages.at(-1);
    assert.match(message, /^\[Location Tracker\] Teste de notificação da área "home":/);
    assert.match(message, /Este é apenas um teste; não indica uma entrada ou saída real\./);
    assert.match(message, /Evento: test/);
    assert.match(message, /Mensagem: Test notification for "home"/);
    assert.ok(message.includes(location ? "Dispositivo: JJ" : "Localização: não informada"));
  }
});

test("Location Tracker accepts null location on all events and nullable accuracy/device, preserving zero values", async (t) => {
  const messages = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    messages.push(JSON.parse(options.body).message);
    return Response.json({});
  });
  for (const event of ["enter", "exit"]) {
    const { response, pending } = await invoke({ ...PAYLOAD, event, location: null });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    assert.match(messages.at(-1), /Localização: não informada/);
  }
  for (const acc of [0, null]) {
    const { response, pending } = await invoke({
      ...PAYLOAD, timestamp: 0,
      geofence: { ...PAYLOAD.geofence, lat: 0, lon: 0 },
      location: { lat: 0, lon: 0, acc, tst: 0, device: null },
    });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    const message = messages.at(-1);
    assert.match(message, /Localização: 0, 0/);
    assert.ok(message.includes(`Precisão: ${acc === null ? "não informada" : "0 m"}`));
    assert.match(message, /Dispositivo: não informado/);
    assert.match(message, /Data e hora do evento: 1970-01-01T00:00:00.000Z/);
    assert.match(message, /Data e hora da localização: 1970-01-01T00:00:00.000Z/);
  }
});

test("Location Tracker rejects absent, malformed and incorrect bearer tokens before parsing JSON", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward unauthorized requests"));
  for (const authorization of [null, "Bearer", "Bearer ", "Basic test-location-secret", "test-location-secret",
    "Bearer wrong", "Bearer test-location-secrex", "Bearer test-location-secret extra"]) {
    const { response, pending } = await invoke(PAYLOAD, { authorization, rawBody: "not json" });
    assert.equal(response.status, 401, String(authorization));
    assert.deepEqual(await response.json(), { error: "invalid_bearer_token" });
    assert.equal(pending.length, 0);
  }
});

test("Location Tracker fails closed when its secret is unset or empty", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward without a configured secret"));
  for (const secret of [undefined, ""]) {
    const { response, pending } = await invoke(PAYLOAD, { env: { LOCATION_TRACKER_WEBHOOK_SECRET: secret } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "missing_webhook_secret" });
    assert.equal(pending.length, 0);
  }
});

test("Location Tracker uses the configured secret, case-insensitive Bearer scheme and custom Poke URL", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  const { response, pending } = await invoke(PAYLOAD, {
    authorization: "bEaReR different-test-token", path: "/location-tracker/",
    env: { LOCATION_TRACKER_WEBHOOK_SECRET: "different-test-token", POKE_API_URL: "https://poke.example/inbound" },
  });
  assert.equal(response.status, 200);
  await Promise.all(pending);
  assert.equal(calls[0].url, "https://poke.example/inbound");
  assert.ok(!calls[0].options.body.includes("different-test-token"));
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-poke-key");
});

test("Location Tracker returns 400 for invalid JSON and malformed known-event payloads without forwarding", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward invalid payloads"));
  const invalidJson = await invoke(PAYLOAD, { rawBody: "{" });
  assert.equal(invalidJson.response.status, 400);
  assert.deepEqual(await invalidJson.response.json(), { error: "invalid_json" });
  assert.equal(invalidJson.pending.length, 0);
  const badPayloads = [null, [], "enter", 1, true, {}, { event: "" }, { event: 42 }];
  for (const field of Object.keys(PAYLOAD)) {
    const payload = structuredClone(PAYLOAD);
    delete payload[field];
    badPayloads.push(payload);
  }
  for (const geofence of [null, [], "home", {},
    ...Object.entries({ id: 42, name: {}, lat: "0", lon: null, radius_m: "200" }).map(([field, value]) => ({ ...PAYLOAD.geofence, [field]: value })),
    ...Object.keys(PAYLOAD.geofence).map((field) => { const fence = { ...PAYLOAD.geofence }; delete fence[field]; return fence; }),
    { ...PAYLOAD.geofence, lat: 91 }, { ...PAYLOAD.geofence, lon: -181 },
    { ...PAYLOAD.geofence, radius_m: 0 }, { ...PAYLOAD.geofence, radius_m: -1 }]) {
    badPayloads.push({ ...PAYLOAD, geofence });
  }
  for (const location of [[], "unknown", {},
    ...Object.entries({ lat: "0", lon: 181, acc: -1, tst: "now", device: 42 }).map(([field, value]) => ({ ...PAYLOAD.location, [field]: value })),
    ...Object.keys(PAYLOAD.location).map((field) => { const loc = { ...PAYLOAD.location }; delete loc[field]; return loc; }),
    { ...PAYLOAD.location, tst: 9e15 }]) {
    badPayloads.push({ ...PAYLOAD, location });
  }
  for (const timestamp of [null, "now", -1, 0.5, 9e15, Infinity]) badPayloads.push({ ...PAYLOAD, timestamp });
  badPayloads.push({ ...PAYLOAD, message: null }, { ...PAYLOAD, message: {} });
  for (const payload of badPayloads) {
    const { response, pending } = await invoke(payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.deepEqual(await response.json(), { error: "invalid_payload" });
    assert.equal(pending.length, 0);
  }
});

test("Location Tracker ignores unknown events and preserves dispatcher method/path behavior", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward unsupported events/routes"));
  const { response, pending } = await invoke({ ...PAYLOAD, event: "update" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "ignored", event_type: "update", event_id: "" });
  assert.equal(pending.length, 0);
  assert.equal((await invoke(PAYLOAD, { method: "GET" })).response.status, 405);
  assert.equal((await invoke(PAYLOAD, { path: "/location-tracker-unknown" })).response.status, 404);
});

test("Location Tracker acknowledges before its registered background forward completes", async (t) => {
  let finish;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { finish = resolve; }));
  const { response, pending } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(pending.length, 1);
  assert.equal(typeof finish, "function");
  finish(Response.json({}));
  assert.deepEqual(await Promise.all(pending), [true]);
});

test("Location Tracker background Poke failures are logged without changing the accepted response", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  for (const failure of ["http", "network", "missing-key"]) {
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new Error("test network failure");
      if (failure === "missing-key") assert.fail("must not call Poke without its API key");
      return new Response("test failure", { status: 503 });
    });
    const { response, pending } = await invoke(PAYLOAD, { env: failure === "missing-key" ? { POKE_API_KEY: "" } : {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await Promise.all(pending), [false]);
  }
  assert.equal(errors.length, 3);
});
