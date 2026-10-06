import { Webhook, WebhookVerificationError } from "standardwebhooks";
import type { Env, SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const EVENT_TYPE = "task_run.status";
const RUN_ID_PREFIX = "trun_";
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export const parallel: SourceHandler = {
  authorize(rawBody, request, env): Response | null {
    const secret = env.PARALLEL_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const headers = {
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
    };
    if (
      !headers["webhook-id"] ||
      !headers["webhook-timestamp"] ||
      !headers["webhook-signature"]
    ) {
      return json(401, { error: "missing_signature_headers" });
    }

    try {
      new Webhook(secret).verify(rawBody, headers);
      return null;
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return json(401, { error: "invalid_signature" });
      }
      throw err;
    }
  },

  async handle(payload, env, ctx): Promise<Response> {
    const eventType = typeof payload.type === "string" ? payload.type : "";
    if (eventType !== EVENT_TYPE) return ignored(eventType || "unknown", "");

    const data = (payload.data ?? {}) as TaskRun;
    const runId = typeof data.run_id === "string" ? data.run_id : "";
    if (!runId.startsWith(RUN_ID_PREFIX)) {
      return json(400, { error: "invalid_run_id", event_type: eventType });
    }

    const status = typeof data.status === "string" ? data.status : "";
    if (!TERMINAL_STATUSES.has(status)) return ignored(eventType, runId);

    if (!env.PARALLEL_API_KEY) return json(500, { error: "missing_api_token" });

    const [input, result] = await Promise.all([
      fetchRunInput(runId, env),
      status === "completed" ? fetchRunResult(runId, env) : Promise.resolve(null),
    ]);

    ctx.waitUntil(forwardToPoke(translate(payload, data, input, result), env));
    return accepted(eventType, runId);
  },
};

interface TaskRun {
  run_id?: string;
  status?: string;
  processor?: string;
  metadata?: Record<string, unknown> | null;
  error?: { message?: string; details?: unknown } | null;
  warnings?: unknown;
  created_at?: string;
  modified_at?: string;
}

interface TaskRunInput {
  input?: unknown;
  processor?: string;
}

interface TaskRunResult {
  output?: { type?: string; content?: unknown } | null;
}

function apiUrl(env: Env, path: string): string {
  return `${env.PARALLEL_API_URL ?? "https://api.parallel.ai/v1"}${path}`;
}

async function fetchJson<T>(path: string, env: Env): Promise<T | null> {
  const res = await fetch(apiUrl(env, path), {
    headers: { "x-api-key": env.PARALLEL_API_KEY },
  });
  if (!res.ok) {
    console.error(`Parallel API error ${res.status} fetching ${path}`);
    return null;
  }
  return (await res.json()) as T;
}

function fetchRunInput(runId: string, env: Env): Promise<TaskRunInput | null> {
  return fetchJson<TaskRunInput>(`/tasks/runs/${runId}/input`, env);
}

function fetchRunResult(runId: string, env: Env): Promise<TaskRunResult | null> {
  return fetchJson<TaskRunResult>(`/tasks/runs/${runId}/result`, env);
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function translate(
  payload: Record<string, unknown>,
  run: TaskRun,
  input: TaskRunInput | null,
  result: TaskRunResult | null,
): string {
  const succeeded = run.status === "completed";
  const header = succeeded
    ? "[Parallel] Execução de tarefa concluída:"
    : "[Parallel] Execução de tarefa falhou:";
  const lines = [
    header,
    `ID da execução: ${run.run_id ?? "não informado"}`,
    `Status: ${run.status ?? "não informado"}`,
    `Processador: ${run.processor ?? input?.processor ?? "não informado"}`,
    `Data e hora: ${run.modified_at ?? payload.timestamp ?? run.created_at ?? "não informadas"}`,
  ];

  const inputText = renderValue(input?.input);
  if (inputText) lines.push("", "Entrada:", inputText);

  const outputText = renderValue(result?.output?.content);
  if (outputText) lines.push("", "Resultado:", outputText);

  if (run.error) {
    const detail = renderValue(run.error.details);
    lines.push(
      `Erro: ${[run.error.message, detail].filter(Boolean).join(" — ")}`,
    );
  }

  const metadata = renderValue(run.metadata);
  if (metadata) lines.push(`Metadados: ${metadata}`);

  return lines.join("\n");
}
