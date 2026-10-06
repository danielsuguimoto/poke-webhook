const assert = require("node:assert/strict");
const { test } = require("node:test");
const { agentmail } = require("../.test-build/sources/agentmail.js");
const { circleback } = require("../.test-build/sources/circleback.js");
const { goalApi } = require("../.test-build/sources/goal-api.js");
const { pluggy } = require("../.test-build/sources/pluggy.js");
const { todoist } = require("../.test-build/sources/todoist.js");

async function forwardedMessage(t, source, payload, task) {
  const originalPayload = structuredClone(payload);
  const originalTask = structuredClone(task);
  const calls = [];
  const pending = [];
  const env = { POKE_API_KEY: "test-poke-key", TODOIST_API_TOKEN: "test-todoist-token" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
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
    calls.push({ url, options });
    return Response.json({});
  });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const payload = { event: "run.completed", run_id: "run-dup-1", data: {} };
  const env = { POKE_API_KEY: "k" };

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
