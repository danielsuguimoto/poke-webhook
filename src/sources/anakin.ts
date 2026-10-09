import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10_000;

// Best-effort deduplication within a worker isolate: Anakin retries deliveries
// for ~8.5h on 5xx/timeouts, resending the same event id (X-Anakin-Delivery-Id).
const seenEvents = new Map<string, number>();

function markSeen(eventId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return false;
  if (seenEvents.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenEvents.keys().next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  seenEvents.set(eventId, now);
  return true;
}

const SUPPORTED_EVENTS = [
  "job.completed",
  "job.failed",
  "batch.completed",
  "batch.failed",
  "wire.job.completed",
  "wire.job.failed",
  "monitor.change",
  "ai.search.completed",
  "ai.search.failed",
  "webhook.test",
] as const;
type AnakinEvent = (typeof SUPPORTED_EVENTS)[number];

export const anakin: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.ANAKIN_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const signature = request.headers.get("x-anakin-signature");
    if (!signature) return json(401, { error: "missing_signature_header" });

    const expected = `sha256=${await hmacHex(secret, rawBody)}`;
    if (!constantTimeEqual(expected, signature)) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, ctx): Promise<Response> {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (!type) return json(400, { error: "invalid_payload" });
    if (!SUPPORTED_EVENTS.includes(type as AnakinEvent)) return ignored(type, "");

    // monitor.change keeps a flat payload (no envelope); its dedup key is changeId.
    const eventId =
      type === "monitor.change"
        ? typeof payload.changeId === "string" ? payload.changeId : ""
        : typeof payload.id === "string" ? payload.id : "";
    if (eventId && !markSeen(eventId)) return ignored(type, eventId);

    const data = (
      type === "monitor.change"
        ? payload
        : payload.data && typeof payload.data === "object"
          ? payload.data
          : {}
    ) as Record<string, unknown>;

    ctx.waitUntil(forwardToPoke(translate(type as AnakinEvent, payload, data), env));
    return accepted(type, eventId);
  },
};

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "";
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function translate(type: AnakinEvent, payload: Record<string, unknown>, data: Record<string, unknown>): string {
  const failed = type.endsWith(".failed");
  const lines: string[] = [];

  if (type === "job.completed" || type === "job.failed") {
    lines.push(
      failed
        ? `[Anakin] Job falhou${data.jobType ? ` (${str(data.jobType)})` : ""}:`
        : `[Anakin] Job concluído${data.jobType ? ` (${str(data.jobType)})` : ""}:`,
    );
    pushField(lines, "ID do job", data.jobId);
    pushField(lines, "URL", data.url);
    pushField(lines, "País", data.country);
    pushField(lines, "Créditos", data.creditsUsed);
    if (typeof data.durationMs === "number") lines.push(`Duração: ${data.durationMs} ms`);
    if (data.createdAt || data.completedAt) {
      lines.push(`Criado em: ${str(data.createdAt) || "não informado"} — Concluído em: ${str(data.completedAt) || "não informado"}`);
    }
    pushField(lines, "Erro", data.error);
    const result = renderValue(data.result);
    if (result) lines.push("", "Resultado:", result);
    pushField(lines, "URL do resultado", data.result_url);
  } else if (type === "batch.completed" || type === "batch.failed") {
    lines.push(failed ? "[Anakin] Lote falhou:" : "[Anakin] Lote concluído:");
    pushField(lines, "ID do lote", data.jobId);
    if (typeof data.urlsTotal === "number") {
      lines.push(
        `URLs: ${data.urlsTotal} no total — ${typeof data.completed === "number" ? data.completed : 0} concluídas, ${typeof data.failed === "number" ? data.failed : 0} falharam`,
      );
    }
    pushField(lines, "Créditos", data.creditsUsed);
    pushField(lines, "URL do resultado", data.result_url);
  } else if (type === "wire.job.completed" || type === "wire.job.failed") {
    lines.push(failed ? "[Anakin] Tarefa Wire falhou:" : "[Anakin] Tarefa Wire concluída:");
    pushField(lines, "ID do job", data.jobId);
    const action = [str(data.actionName), str(data.actionId)].filter(Boolean).join(" — ");
    if (action) lines.push(`Ação: ${action}`);
    pushField(lines, "Catálogo", data.catalogSlug);
    pushField(lines, "Créditos", data.creditsUsed);
    if (typeof data.durationMs === "number") lines.push(`Duração: ${data.durationMs} ms`);
    pushField(lines, "Erro", data.error);
    const result = renderValue(data.result);
    if (result) lines.push("", "Resultado:", result);
    pushField(lines, "URL do resultado", data.result_url);
  } else if (type === "monitor.change") {
    lines.push("[Anakin] Monitor detectou uma mudança:");
    pushField(lines, "URL", data.url);
    pushField(lines, "Monitor", data.monitorId);
    pushField(lines, "Modo", data.watchMode);
    pushField(lines, "Alterado em", data.changedAt);
    if (Array.isArray(data.changedFields) && data.changedFields.length) {
      lines.push(`Campos alterados: ${data.changedFields.join(", ")}`);
    }
    pushField(lines, "Resumo", data.summary);
    const diff = renderValue(data.diff);
    if (diff) lines.push("", "Diff:", diff);
  } else if (type === "ai.search.completed" || type === "ai.search.failed") {
    lines.push(failed ? "[Anakin] Pesquisa de AI Visibility falhou:" : "[Anakin] Pesquisa de AI Visibility concluída:");
    pushField(lines, "ID da pesquisa", data.searchId);
    pushField(lines, "Consulta", data.query);
    pushField(lines, "País", data.country);
    pushField(lines, "Créditos", data.creditsUsed);
    pushField(lines, "Concluída em", data.completedAt);
    if (Array.isArray(data.sources) && data.sources.length) {
      lines.push("", "Fontes:");
      for (const s of data.sources) {
        if (!s || typeof s !== "object") continue;
        const src = s as Record<string, unknown>;
        const detail = str(src.summary) || str(src.error);
        lines.push(
          `- ${str(src.source) || "?"}: ${str(src.status) || "?"}${typeof src.latencyMs === "number" ? ` (${src.latencyMs} ms)` : ""}${detail ? ` — ${detail}` : ""}`,
        );
      }
    }
    pushField(lines, "Síntese", data.synthesis);
    pushField(lines, "URL do resultado", data.result_url);
  } else {
    lines.push("[Anakin] Evento de teste recebido:");
    pushField(lines, "Endpoint", data.endpointId);
    pushField(lines, "Mensagem", data.message);
  }

  if (str(payload.createdAt) && type !== "monitor.change") {
    lines.push(`Evento criado em: ${str(payload.createdAt)}`);
  }
  return lines.join("\n");
}

function pushField(lines: string[], label: string, value: unknown): void {
  const text = renderValue(value);
  if (text) lines.push(`${label}: ${text}`);
}
