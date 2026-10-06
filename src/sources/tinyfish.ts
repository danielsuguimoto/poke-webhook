import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const TINYFISH_API_URL = "https://agent.tinyfish.ai";
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10_000;

// Best-effort deduplication within a worker isolate: TinyFish may deliver the
// same terminal event more than once (network retries, server restarts).
const seenRuns = new Map<string, number>();

function markSeen(runId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenRuns) {
    if (now - ts > DEDUP_TTL_MS) seenRuns.delete(id);
  }
  if (seenRuns.has(runId)) return false;
  if (seenRuns.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenRuns.keys().next().value;
    if (oldest !== undefined) seenRuns.delete(oldest);
  }
  seenRuns.set(runId, now);
  return true;
}

const SUPPORTED_EVENTS = ["run.completed", "run.failed", "run.cancelled"] as const;
type TinyfishEvent = (typeof SUPPORTED_EVENTS)[number];

interface TinyfishRun {
  run_id?: string;
  status?: string;
  goal?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  num_of_steps?: number;
  result?: unknown;
  error?: { message?: unknown; category?: unknown } | null;
  streaming_url?: string;
  steps?: unknown[];
}

export const tinyfish: SourceHandler = {
  async handle(payload, env, ctx): Promise<Response> {
    const event = typeof payload.event === "string" ? payload.event : "";
    const runId =
      typeof payload.run_id === "string" && payload.run_id ? payload.run_id : "";
    if (!event || !runId) return json(400, { error: "invalid_payload" });
    if (!SUPPORTED_EVENTS.includes(event as TinyfishEvent)) {
      return ignored(event, runId);
    }
    if (env.TINYFISH_API_KEY) {
      const verification = await verifyRun(runId, event as TinyfishEvent, env.TINYFISH_API_KEY);
      if (verification) return verification;
    }

    if (!markSeen(runId)) return ignored(event, runId);

    const data = (
      payload.data && typeof payload.data === "object" ? payload.data : {}
    ) as TinyfishRun;
    ctx.waitUntil(forwardToPoke(translate(event as TinyfishEvent, runId, data), env));
    return accepted(event, runId);
  },
};

async function verifyRun(
  runId: string,
  event: TinyfishEvent,
  apiKey: string,
): Promise<Response | null> {
  try {
    const res = await fetch(`${TINYFISH_API_URL}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: { "X-API-Key": apiKey },
    });
    if (res.status === 404) return json(401, { error: "unknown_run" });
    if (!res.ok) {
      console.error(`TinyFish API error ${res.status} verifying run ${runId}`);
      return null;
    }
    const run = (await res.json()) as { status?: string };
    const expected = event.split(".")[1].toUpperCase();
    if (run.status && run.status !== expected) {
      return json(409, { error: "status_mismatch", status: run.status });
    }
  } catch (err) {
    console.error(`TinyFish run verification failed for ${runId}:`, err);
  }
  return null;
}

function translate(event: TinyfishEvent, runId: string, data: TinyfishRun): string {
  const lines: string[] = [];
  if (event === "run.completed") {
    lines.push("[Tinyfish] Execução concluída:");
  } else if (event === "run.failed") {
    lines.push("[Tinyfish] Execução falhou:");
  } else {
    lines.push("[Tinyfish] Execução cancelada:");
  }
  lines.push(`ID da execução: ${runId}`);
  if (data.goal) lines.push(`Objetivo: ${data.goal}`);
  if (data.status) lines.push(`Status: ${data.status}`);
  if (data.started_at || data.finished_at) {
    lines.push(
      `Início: ${data.started_at ?? "não informado"} — Fim: ${data.finished_at ?? "não informado"}`,
    );
  }
  if (typeof data.num_of_steps === "number") lines.push(`Passos: ${data.num_of_steps}`);
  if (data.streaming_url) lines.push(`Gravação: ${data.streaming_url}`);

  const error = data.error;
  if (error && typeof error === "object") {
    const parts = [error.category, error.message].filter(
      (v): v is string => typeof v === "string" && !!v,
    );
    if (parts.length) lines.push(`Erro: ${parts.join(" — ")}`);
  }

  if (data.result !== undefined && data.result !== null) {
    lines.push("", "Resultado:", JSON.stringify(data.result, null, 2));
  }

  return lines.join("\n");
}
