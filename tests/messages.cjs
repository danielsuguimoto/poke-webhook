const assert = require("node:assert/strict");
const { test } = require("node:test");
const { agentmail } = require("../.test-build/sources/agentmail.js");
const { anakin } = require("../.test-build/sources/anakin.js");
const { circleback } = require("../.test-build/sources/circleback.js");
const { goalApi } = require("../.test-build/sources/goal-api.js");
const { parallel } = require("../.test-build/sources/parallel.js");
const { pluggy } = require("../.test-build/sources/pluggy.js");
const { ramble } = require("../.test-build/sources/ramble.js");
const { todoist } = require("../.test-build/sources/todoist.js");

async function forwardedMessage(t, source, payload, task) {
  const originalPayload = structuredClone(payload);
  const originalTask = structuredClone(task);
  const calls = [];
  const pending = [];
  const env = { POKE_API_KEY: "test-poke-key", TODOIST_API_TOKEN: "test-todoist-token", TINYFISH_API_KEY: "test-tinyfish-key" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("https://agent.tinyfish.ai/")) {
      const status = { "run.completed": "COMPLETED", "run.failed": "FAILED", "run.cancelled": "CANCELLED" }[payload.event];
      assert.equal(options.headers["X-API-Key"], "test-tinyfish-key");
      return Response.json({ status });
    }
    if (url.startsWith("https://api.todoist.com/")) {
      assert.equal(url, `https://api.todoist.com/api/v1/tasks/${payload.event_data.item_id}`);
      assert.equal(options.headers.Authorization, "Bearer test-todoist-token");
      return Response.json(task);
    }
    calls.push({ url, options });
    return Response.json({});
  });

  const response = await source.handle(payload, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://poke.com/api/v1/inbound/api-message");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-poke-key");
  assert.deepEqual(payload, originalPayload);
  assert.deepEqual(task, originalTask);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body), ["message"]);
  return body.message;
}

test("AgentMail translates received-email labels while preserving source content", async (t) => {
  const message = await forwardedMessage(t, agentmail, {
    event_type: "message.received", event_id: "evt-1",
    message: {
      from: "Alice <alice@example.com>", to: ["agent@example.com"], cc: ["bob@example.com"],
      subject: "Meeting — tomorrow", text: "Please review the attached report.\nKeep this in English.",
      timestamp: "2026-10-01T10:00:00Z", thread_id: "thread-1",
    },
  });
  assert.equal(message, [
    "[AgentMail] Novo e-mail recebido na sua caixa de entrada do AgentMail agent@example.com:",
    "De: Alice <alice@example.com>", "Para: agent@example.com", "Cc: bob@example.com",
    "Assunto: Meeting — tomorrow", "Data e hora: 2026-10-01T10:00:00Z", "Conversa: thread-1", "",
    "Please review the attached report.\nKeep this in English.",
  ].join("\n"));
});

for (const [eventType, field, header] of [
  ["message.sent", "send", "Sua caixa de entrada do AgentMail inbox-1 enviou um e-mail:"],
  ["message.delivered", "delivery", "O e-mail enviado pela sua caixa de entrada do AgentMail inbox-1 foi entregue ao servidor de e-mail do destinatário:"],
]) {
  test(`AgentMail ${eventType} keeps recipient addresses and identifiers`, async (t) => {
    const message = await forwardedMessage(t, agentmail, {
      event_type: eventType, event_id: "evt-1",
      [field]: { inbox_id: "inbox-1", recipients: ["alice@example.com", "bob@example.com"], thread_id: "thread-1", timestamp: "2026-10-01T10:00:00Z" },
    });
    assert.equal(message, [
      `[AgentMail] ${header}`, "Destinatários: alice@example.com, bob@example.com",
      "Conversa: thread-1", "Data e hora: 2026-10-01T10:00:00Z",
    ].join("\n"));
  });
}

test("AgentMail missing content uses Portuguese fallbacks", async (t) => {
  const message = await forwardedMessage(t, agentmail, { event_type: "message.received" });
  assert.equal(message, [
    "[AgentMail] Novo e-mail recebido na sua caixa de entrada do AgentMail não informada:",
    "De: não informado", "Para: não informado", "Assunto: (sem assunto)",
    "Data e hora: não informadas", "Conversa: ?", "", "(sem conteúdo)",
  ].join("\n"));
});

test("Circleback translates sections and derived statuses, preserving meeting content", async (t) => {
  const message = await forwardedMessage(t, circleback, {
    id: "meeting-1", name: "Weekly review", createdAt: "2026-10-01T10:00:00Z", duration: 120,
    attendees: [{ name: "Alice" }, { email: "bob@example.com" }], tags: ["work", "review"],
    url: "https://example.com/meeting", notes: "Discuss the roadmap.\nNext steps in English.",
    actionItems: [{ title: "Send the report", status: "DONE", assignee: { name: "Alice" } }, { title: "Review the roadmap", status: "TODO" }],
    insights: { Decisions: [{ speaker: "Alice", insight: "Ship next week" }, { insight: { status: "approved", detail: "Keep original keys" } }] },
    transcript: [{ speaker: "Alice", text: "Let's ship next week." }, { text: "Agreed." }],
  });
  assert.equal(message, [
    '[Circleback] Notas da reunião "Weekly review":', "Link: https://circleback.ai/meetings/meeting-1",
    "Data e hora: 2026-10-01T10:00:00Z", "Duração: 2.0 min", "Participantes: Alice, bob@example.com",
    "Etiquetas: work, review", "URL da reunião: https://example.com/meeting", "", "Ações:",
    "- [concluído] Send the report (responsável: Alice)", "- [pendente] Review the roadmap (responsável: sem responsável)",
    "", "Notas:", "Discuss the roadmap.\nNext steps in English.", "", "Observações:",
    "- [Decisions] (Alice) Ship next week", '- [Decisions] {"status":"approved","detail":"Keep original keys"}',
    "", "Transcrição (2 segmentos):", "Alice: Let's ship next week.", "não informado: Agreed.",
  ].join("\n"));
});

test("Circleback missing metadata uses Portuguese fallbacks", async (t) => {
  const message = await forwardedMessage(t, circleback, { id: "meeting-1" });
  assert.equal(message, [
    '[Circleback] Notas da reunião "sem título":', "Link: https://circleback.ai/meetings/meeting-1",
    "Data e hora: não informadas", "Duração: não informada",
  ].join("\n"));
});

test("GOAL API preserves every original JSON key and value", async (t) => {
  const payload = {
    event: "goal.scored", id: "goal-1", description: "Home team scored!",
    data: { team: "São Paulo", status: "LIVE", score: { home: 1, away: 0 }, players: ["Alice", "Bob"], extra: null },
  };
  const message = await forwardedMessage(t, goalApi, payload);
  assert.equal(message, `[Goal API] Evento: goal.scored\n\n${JSON.stringify(payload, null, 2)}`);
  assert.deepEqual(JSON.parse(message.split("\n\n")[1]), payload);
});

test("Pluggy translates labels while preserving raw event, status, IDs and error details", async (t) => {
  const message = await forwardedMessage(t, pluggy, {
    event: "item/error", eventId: "evt-1", itemId: "item-1", connectorId: 42,
    paymentRequestId: "request-1", paymentIntentId: "intent-1", schedulePaymentId: "schedule-1",
    automaticPixPaymentId: "pix-1", smartTransferPreauthorizationId: "preauth-1", smartTransferPaymentId: "transfer-1",
    transactionIds: ["tx-1", "tx-2"], clientUserId: "user-1", triggeredBy: "USER", status: "ERROR",
    createdTransactionsLink: "https://example.com/transactions?status=CREATED",
    error: { code: "INVALID_CREDENTIALS", description: "Invalid credentials", detail: "Please reconnect" },
  });
  assert.equal(message, [
    "[Pluggy] Ocorreu um erro no item (item/error).", "ID do item: item-1", "ID do conector: 42",
    "ID da solicitação de pagamento: request-1", "ID da intenção de pagamento: intent-1", "ID do pagamento agendado: schedule-1",
    "ID do pagamento via Pix Automático: pix-1", "ID da pré-autorização de transferência inteligente: preauth-1",
    "ID do pagamento de transferência inteligente: transfer-1", "IDs das transações: 2 IDs: tx-1, tx-2",
    "ID do usuário do cliente: user-1", "Disparado por: USER", "Status: ERROR",
    "Link das transações criadas: https://example.com/transactions?status=CREATED",
    "Erro: INVALID_CREDENTIALS — Invalid credentials — Please reconnect",
  ].join("\n"));
});

test("Pluggy keeps string errors and the existing large-array summary", async (t) => {
  const message = await forwardedMessage(t, pluggy, {
    event: "transactions/created", transactionIds: Array.from({ length: 21 }, (_, i) => `tx-${i}`),
    error: "Original English error",
  });
  assert.equal(message, [
    "[Pluggy] Novas transações disponíveis (transactions/created).", "IDs das transações: 21 IDs", "Erro: Original English error",
  ].join("\n"));
});

for (const ai of [true, false]) {
  test(`Todoist ${ai ? "executes AI tasks" : "warns about other tasks"} in Portuguese without translating task data`, async (t) => {
    const message = await forwardedMessage(t, todoist, {
      event_name: "reminder:fired", event_data: { id: "reminder-1", item_id: "task-1", due: { string: "today at 9am" } },
    }, {
      id: "task-1", content: "Review the report", description: "Leave the report in English.",
      labels: ai ? ["AI", "work"] : ["work"], priority: 4, url: "https://todoist.com/showTask?id=task-1", due: { string: "tomorrow" },
    });
    assert.equal(message, [
      ai ? '[Todoist] Lembrete disparado para uma tarefa com a etiqueta "ai" — execute esta tarefa e, após a execução, marque-a como concluída no Todoist:'
        : "[Todoist] Lembrete disparado — avise o usuário sobre esta tarefa:",
      "Tarefa: Review the report", "Descrição: Leave the report in English.", "Prazo: tomorrow", "Prioridade: 4",
      `Etiquetas: ${ai ? "AI, work" : "work"}`, "Link: https://todoist.com/showTask?id=task-1", "Lembrete: today at 9am",
    ].join("\n"));
  });
}

test("Todoist missing task metadata uses Portuguese fallbacks", async (t) => {
  const message = await forwardedMessage(t, todoist, {
    event_name: "reminder:fired", event_data: { item_id: "task-1" },
  }, {});
  assert.equal(message, [
    "[Todoist] Lembrete disparado — avise o usuário sobre esta tarefa:", "Tarefa: (sem título)", "Prioridade: não informada",
  ].join("\n"));
});

const { tinyfish } = require("../.test-build/sources/tinyfish.js");

test("TinyFish run.completed forwards goal, status and result", async (t) => {
  const message = await forwardedMessage(t, tinyfish, {
    event: "run.completed", run_id: "run-completed-1", status: "COMPLETED",
    data: {
      goal: "Extract the page title", status: "COMPLETED",
      started_at: "2026-03-25T10:30:05Z", finished_at: "2026-03-25T10:30:45Z",
      num_of_steps: 3, result: { title: "Example Domain" }, error: null,
      streaming_url: "https://tf-abc123.fra0-tinyfish.unikraft.app/stream/0",
    },
  });
  assert.equal(message, [
    "[Tinyfish] Execução concluída:", "ID da execução: run-completed-1",
    "Objetivo: Extract the page title", "Status: COMPLETED",
    "Início: 2026-03-25T10:30:05Z — Fim: 2026-03-25T10:30:45Z",
    "Passos: 3", "Gravação: https://tf-abc123.fra0-tinyfish.unikraft.app/stream/0",
    "", "Resultado:", '{\n  "title": "Example Domain"\n}',
  ].join("\n"));
});

test("TinyFish run.failed forwards error category and message", async (t) => {
  const message = await forwardedMessage(t, tinyfish, {
    event: "run.failed", run_id: "run-failed-1", status: "FAILED",
    data: { error: { message: "Site blocked access", category: "AGENT_FAILURE" }, result: null },
  });
  assert.equal(message, [
    "[Tinyfish] Execução falhou:", "ID da execução: run-failed-1",
    "Erro: AGENT_FAILURE — Site blocked access",
  ].join("\n"));
});

test("TinyFish run.cancelled forwards a cancellation notice", async (t) => {
  const message = await forwardedMessage(t, tinyfish, {
    event: "run.cancelled", run_id: "run-cancelled-1", status: "CANCELLED", data: {},
  });
  assert.equal(message, [
    "[Tinyfish] Execução cancelada:", "ID da execução: run-cancelled-1",
  ].join("\n"));
});

test("TinyFish rejects malformed payloads with 400", async () => {
  const ctx = { waitUntil: () => {} };
  for (const payload of [
    {}, { event: "run.completed" }, { run_id: "run-1" }, { event: "run.completed", run_id: 42 },
  ]) {
    const res = await tinyfish.handle(payload, { POKE_API_KEY: "k" }, ctx);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_payload");
  }
});

test("TinyFish acknowledges unknown events with 202 without forwarding", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const res = await tinyfish.handle(
    { event: "run.started", run_id: "run-unknown-1" },
    { POKE_API_KEY: "k" },
    { waitUntil: () => {} },
  );
  assert.equal(res.status, 202);
  assert.equal(calls.length, 0);
});

test("TinyFish deduplicates deliveries by run_id", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("https://agent.tinyfish.ai/")) {
      return Response.json({ status: "COMPLETED" });
    }
    calls.push({ url, options });
    return Response.json({});
  });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const payload = { event: "run.completed", run_id: "run-dup-1", data: {} };
  const env = { POKE_API_KEY: "k", TINYFISH_API_KEY: "tinyfish-key" };

  const first = await tinyfish.handle(structuredClone(payload), env, ctx);
  const second = await tinyfish.handle(structuredClone(payload), env, ctx);
  await Promise.all(pending);

  assert.equal(first.status, 200);
  assert.equal(second.status, 202);
  assert.equal(calls.length, 1);
});

test("TinyFish verifies run_id against the API when TINYFISH_API_KEY is set", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://agent.tinyfish.ai/")) {
      assert.equal(url, "https://agent.tinyfish.ai/v1/runs/run-verified-1");
      assert.equal(options.headers["X-API-Key"], "tinyfish-key");
      return Response.json({ status: "COMPLETED" });
    }
    return Response.json({});
  });
  const pending = [];
  const res = await tinyfish.handle(
    { event: "run.completed", run_id: "run-verified-1", data: {} },
    { POKE_API_KEY: "k", TINYFISH_API_KEY: "tinyfish-key" },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("TinyFish rejects runs the API does not know", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    return new Response("not found", { status: 404 });
  });
  const res = await tinyfish.handle(
    { event: "run.completed", run_id: "run-forged-1", data: {} },
    { POKE_API_KEY: "k", TINYFISH_API_KEY: "tinyfish-key" },
    { waitUntil: () => {} },
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 1);
});

test("TinyFish fails closed when TINYFISH_API_KEY is missing", async () => {
  const calls = [];
  const res = await tinyfish.handle(
    { event: "run.completed", run_id: "run-nokey-1", data: {} },
    { POKE_API_KEY: "k" },
    { waitUntil: (p) => calls.push(p) },
  );
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "missing_tinyfish_api_key");
  assert.equal(calls.length, 0);
});

test("TinyFish fails closed with 503 when run verification errors", async (t) => {
  for (const [runId, impl] of [
    ["run-verify-err-1", async () => new Response("boom", { status: 500 })],
    ["run-verify-err-2", async () => { throw new Error("network down"); }],
  ]) {
    t.mock.method(globalThis, "fetch", impl);
    const calls = [];
    const res = await tinyfish.handle(
      { event: "run.completed", run_id: runId, data: {} },
      { POKE_API_KEY: "k", TINYFISH_API_KEY: "tinyfish-key" },
      { waitUntil: (p) => calls.push(p) },
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "verification_failed");
    assert.equal(calls.length, 0);
  }
});

test("TinyFish rejects payloads whose status does not match the run", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ status: "FAILED" }),
  );
  const res = await tinyfish.handle(
    { event: "run.completed", run_id: "run-mismatch-1", data: {} },
    { POKE_API_KEY: "k", TINYFISH_API_KEY: "tinyfish-key" },
    { waitUntil: () => {} },
  );
  assert.equal(res.status, 409);
});

async function parallelForwardedMessage(t, payload, { input = null, result = null } = {}) {
  const calls = [];
  const pending = [];
  const env = { POKE_API_KEY: "test-poke-key", PARALLEL_API_KEY: "test-parallel-key" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("https://api.parallel.ai/")) {
      assert.equal(options.headers["x-api-key"], "test-parallel-key");
      if (url.endsWith("/input")) return Response.json(input);
      if (url.endsWith("/result")) return Response.json(result);
      throw new Error(`unexpected Parallel URL ${url}`);
    }
    calls.push({ url, options });
    return Response.json({});
  });

  const response = await parallel.handle(payload, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://poke.com/api/v1/inbound/api-message");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-poke-key");
  return JSON.parse(calls[0].options.body).message;
}

test("Parallel completed run forwards input and output, preserving source content", async (t) => {
  const message = await parallelForwardedMessage(t, {
    timestamp: "2025-04-23T20:21:48.037943Z", type: "task_run.status",
    data: {
      run_id: "trun_abc123", status: "completed", is_active: false, processor: "core",
      metadata: { key: "value" }, created_at: "2025-04-23T20:20:00Z", modified_at: "2025-04-23T20:21:48.037943Z",
    },
  }, {
    input: { processor: "core", input: { country: "France", year: 2023 } },
    result: { output: { type: "json", content: { gdp: "$3.1 trillion (2023)" } } },
  });
  assert.equal(message, [
    "[Parallel] Execução de tarefa concluída:", "ID da execução: trun_abc123", "Status: completed",
    "Processador: core", "Data e hora: 2025-04-23T20:21:48.037943Z", "", "Entrada:",
    JSON.stringify({ country: "France", year: 2023 }, null, 2), "", "Resultado:",
    JSON.stringify({ gdp: "$3.1 trillion (2023)" }, null, 2), 'Metadados: {\n  "key": "value"\n}',
  ].join("\n"));
});

test("Parallel failed run reports the error and skips the result fetch", async (t) => {
  const message = await parallelForwardedMessage(t, {
    timestamp: "2025-04-23T20:21:48.037943Z", type: "task_run.status",
    data: {
      run_id: "trun_def456", status: "failed", processor: "base",
      error: { message: "Task execution failed", details: "Additional error details" },
    },
  }, { input: { input: "France (2023)" } });
  assert.equal(message, [
    "[Parallel] Execução de tarefa falhou:", "ID da execução: trun_def456", "Status: failed",
    "Processador: base", "Data e hora: 2025-04-23T20:21:48.037943Z", "", "Entrada:", "France (2023)",
    "Erro: Task execution failed — Additional error details",
  ].join("\n"));
});

test("Parallel non-terminal status is ignored without forwarding", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push(url); return Response.json({}); });
  const response = await parallel.handle(
    { type: "task_run.status", data: { run_id: "trun_abc123", status: "running" } },
    { POKE_API_KEY: "k", PARALLEL_API_KEY: "k" }, { waitUntil: () => {} },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "ignored", event_type: "task_run.status", event_id: "trun_abc123" });
  assert.equal(calls.length, 0);
});

test("Parallel malformed run id returns 400 and unknown types are ignored", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const env = { POKE_API_KEY: "k", PARALLEL_API_KEY: "k" };
  const ctx = { waitUntil: () => {} };

  const bad = await parallel.handle({ type: "task_run.status", data: { run_id: "bogus" } }, env, ctx);
  assert.equal(bad.status, 400);

  const other = await parallel.handle({ type: "other.event", data: {} }, env, ctx);
  assert.equal(other.status, 202);
});

test("Anakin job.completed forwards job fields and inlined result", async (t) => {
  const message = await forwardedMessage(t, anakin, {
    id: "evt-anakin-1", type: "job.completed", createdAt: "2026-07-13T10:00:05Z",
    data: {
      jobId: "0b0e5e7e", jobType: "url_scraper", status: "completed",
      url: "https://example.com", country: "us", creditsUsed: 1, durationMs: 5000,
      createdAt: "2026-07-13T10:00:00Z", completedAt: "2026-07-13T10:00:05Z",
      result_url: "https://api.anakin.io/v1/url-scraper/0b0e5e7e",
      result: { markdown: "# Page content" },
    },
  });
  assert.equal(message, [
    "[Anakin] Job concluído (url_scraper):", "ID do job: 0b0e5e7e", "URL: https://example.com",
    "País: us", "Créditos: 1", "Duração: 5000 ms",
    "Criado em: 2026-07-13T10:00:00Z — Concluído em: 2026-07-13T10:00:05Z", "", "Resultado:",
    JSON.stringify({ markdown: "# Page content" }, null, 2),
    "URL do resultado: https://api.anakin.io/v1/url-scraper/0b0e5e7e",
    "Evento criado em: 2026-07-13T10:00:05Z",
  ].join("\n"));
});

test("Anakin monitor.change uses the flat payload without an envelope", async (t) => {
  const message = await forwardedMessage(t, anakin, {
    type: "monitor.change", monitorId: "mon-1", url: "https://example.com/product/123",
    watchMode: "specific_data", changeId: "chg-1", changedAt: "2026-07-13T10:00:00Z",
    changedFields: ["price"], summary: "The price dropped from $19.99 to $14.99.",
    diff: { before: { price: 19.99 }, after: { price: 14.99 } },
  });
  assert.equal(message, [
    "[Anakin] Monitor detectou uma mudança:", "URL: https://example.com/product/123",
    "Monitor: mon-1", "Modo: specific_data", "Alterado em: 2026-07-13T10:00:00Z",
    "Campos alterados: price", "Resumo: The price dropped from $19.99 to $14.99.", "", "Diff:",
    JSON.stringify({ before: { price: 19.99 }, after: { price: 14.99 } }, null, 2),
  ].join("\n"));
});

test("Anakin ai.search.completed lists per-source summaries", async (t) => {
  const message = await forwardedMessage(t, anakin, {
    id: "evt-anakin-2", type: "ai.search.completed", createdAt: "2026-07-15T12:03:41Z",
    data: {
      searchId: "3d9db7ff", query: "Best coding agents in 2026", status: "completed",
      country: "us", creditsUsed: 3, completedAt: "2026-07-15T12:03:41Z",
      sources: [
        { source: "chatgpt", status: "completed", latencyMs: 9100, creditsUsed: 1, summary: "The leading coding agents in 2026 are…" },
        { source: "google_ai_overview", status: "failed", latencyMs: 150000, creditsUsed: 0, error: "source timed out" },
      ],
      result_url: "https://api.anakin.io/v1/ai-visibility/search/3d9db7ff",
    },
  });
  assert.equal(message, [
    "[Anakin] Pesquisa de AI Visibility concluída:", "ID da pesquisa: 3d9db7ff",
    "Consulta: Best coding agents in 2026", "País: us", "Créditos: 3",
    "Concluída em: 2026-07-15T12:03:41Z", "", "Fontes:",
    "- chatgpt: completed (9100 ms) — The leading coding agents in 2026 are…",
    "- google_ai_overview: failed (150000 ms) — source timed out",
    "URL do resultado: https://api.anakin.io/v1/ai-visibility/search/3d9db7ff",
    "Evento criado em: 2026-07-15T12:03:41Z",
  ].join("\n"));
});

test("Anakin duplicate deliveries and unknown types are ignored", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const env = { POKE_API_KEY: "k" };
  const ctx = { waitUntil: () => {} };
  const payload = { id: "evt-anakin-3", type: "webhook.test", data: { endpointId: "ep-1", message: "test" } };

  const first = await anakin.handle(payload, env, ctx);
  assert.equal(first.status, 200);
  const second = await anakin.handle({ ...payload }, env, ctx);
  assert.equal(second.status, 202);

  const other = await anakin.handle({ id: "evt-anakin-4", type: "future.event", data: {} }, env, ctx);
  assert.equal(other.status, 202);

  const bad = await anakin.handle({ data: {} }, env, ctx);
  assert.equal(bad.status, 400);
});

test("Ramble forwards recording metadata and transcript, preserving source content", async (t) => {
  const message = await forwardedMessage(t, ramble, {
    recording_id: "550e8400-e29b-41d4-a716-446655440000",
    created_at: "2026-03-17T13:19:00Z",
    duration: 138.5,
    transcription: "Just had a great idea for the landing page.\nKeep this in English.",
    device_id: "7a2b3c4d-5e6f-7890-abcd-ef1234567890",
  });
  assert.equal(message, [
    "[Ramble] Nova transcrição recebida:",
    "ID da gravação: 550e8400-e29b-41d4-a716-446655440000",
    "Data e hora: 2026-03-17T13:19:00Z",
    "Duração: 138.5 s",
    "Dispositivo: 7a2b3c4d-5e6f-7890-abcd-ef1234567890",
    "", "Transcrição:", "Just had a great idea for the landing page.\nKeep this in English.",
  ].join("\n"));
});

test("Ramble test payload is always forwarded with a test header", async (t) => {
  const payload = {
    recording_id: "test-550e8400-e29b-41d4-a716-446655440000",
    created_at: "2026-04-09T12:00:00Z",
    duration: 0,
    transcription: "This is a test webhook from Ramble.",
    device_id: "7a2b3c4d-5e6f-7890-abcd-ef1234567890",
    test: true,
  };
  for (let i = 0; i < 2; i++) {
    const message = await forwardedMessage(t, ramble, payload);
    assert.equal(message, [
      "[Ramble] Webhook de teste recebido:",
      "ID da gravação: test-550e8400-e29b-41d4-a716-446655440000",
      "Data e hora: 2026-04-09T12:00:00Z",
      "Duração: 0.0 s",
      "Dispositivo: 7a2b3c4d-5e6f-7890-abcd-ef1234567890",
      "", "Transcrição:", "This is a test webhook from Ramble.",
    ].join("\n"));
  }
});

test("Ramble missing fields use Portuguese fallbacks", async (t) => {
  const message = await forwardedMessage(t, ramble, { recording_id: "rec-fallback-1" });
  assert.equal(message, [
    "[Ramble] Nova transcrição recebida:",
    "ID da gravação: rec-fallback-1",
    "Data e hora: não informadas",
    "", "Transcrição:", "(sem conteúdo)",
  ].join("\n"));
});

test("Ramble rejects payloads without recording_id", async () => {
  for (const payload of [null, {}, { recording_id: 42 }, { transcription: "hi" }, "text", 42]) {
    const res = await ramble.handle(payload, { POKE_API_KEY: "k" }, { waitUntil: () => {} });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_payload");
  }
});

test("Ramble returns 503 when forwarding fails and redelivers on retry", async (t) => {
  const calls = [];
  let pokeOk = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    return pokeOk ? Response.json({}) : new Response("boom", { status: 500 });
  });
  const env = { POKE_API_KEY: "k" };
  const ctx = { waitUntil: () => {} };
  const payload = { recording_id: "rec-retry-1", transcription: "retry me" };

  const first = await ramble.handle(structuredClone(payload), env, ctx);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, "poke_forward_failed");

  pokeOk = true;
  const second = await ramble.handle(structuredClone(payload), env, ctx);
  assert.equal(second.status, 200);
  const third = await ramble.handle(structuredClone(payload), env, ctx);
  assert.equal(third.status, 202);
  assert.equal(calls.length, 2);
});

test("Ramble deduplicates retried deliveries by recording_id", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const payload = { recording_id: "rec-dup-1", transcription: "dup" };
  const env = { POKE_API_KEY: "k" };

  const first = await ramble.handle(structuredClone(payload), env, ctx);
  const second = await ramble.handle(structuredClone(payload), env, ctx);
  const third = await ramble.handle(structuredClone(payload), env, ctx);
  await Promise.all(pending);

  assert.equal(first.status, 200);
  assert.equal(second.status, 202);
  assert.equal(third.status, 202);
  assert.equal(calls.length, 1);
});

async function rambleSignature(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function rambleAuthRequest(signature) {
  return new Request("https://worker.test/ramble", {
    method: "POST",
    headers: signature ? { "x-webhook-signature": signature } : {},
  });
}

test("Ramble authorize verifies the X-Webhook-Signature HMAC", async () => {
  const body = JSON.stringify({ recording_id: "rec-1", transcription: "hi" });
  const env = { RAMBLE_WEBHOOK_SECRET: "ramble-secret" };

  assert.equal(await ramble.authorize(body, rambleAuthRequest(await rambleSignature("ramble-secret", body)), env), null);

  for (const [sig, expected] of [
    [null, "missing_signature_header"],
    ["sha256=deadbeef", "invalid_signature"],
    [await rambleSignature("other-secret", body), "invalid_signature"],
    [await rambleSignature("ramble-secret", body + " "), "invalid_signature"],
  ]) {
    const res = await ramble.authorize(body, rambleAuthRequest(sig), env);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, expected);
  }
});

test("Ramble authorize fails closed when the secret is not configured", async () => {
  const res = await ramble.authorize("{}", rambleAuthRequest("sha256=x"), {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "missing_webhook_secret");
});
