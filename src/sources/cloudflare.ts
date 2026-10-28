import type { SourceHandler } from "../index";
import { forwardToPoke, accepted } from "../poke";
import { json } from "../utils";

export interface CloudflareEvent extends Record<string, unknown> {
  type: string;
  source: Record<string, unknown> & { type: string };
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & { eventTimestamp?: string };
}

const BUILD_TITLES: Record<string, string> = {
  "cf.workersBuilds.worker.build.started": "Build iniciado",
  "cf.workersBuilds.worker.build.succeeded": "Build concluído com sucesso",
  "cf.workersBuilds.worker.build.failed": "Falha no build",
  "cf.workersBuilds.worker.build.canceled": "Build cancelado",
};

export const cloudflare: SourceHandler = {
  authorize(): Response {
    return json(403, { error: "queue_only_source" });
  },

  async handle(payload, env): Promise<Response> {
    if (!isCloudflareEvent(payload)) return json(400, { error: "invalid_payload" });
    if (!await forwardToPoke(translate(payload), env)) {
      return json(503, { error: "forward_failed" });
    }
    const eventId = typeof payload.payload.buildUuid === "string" ? payload.payload.buildUuid : "";
    return accepted(payload.type, eventId);
  },
};

export function isCloudflareEvent(value: unknown): value is CloudflareEvent {
  return isRecord(value) &&
    isRecord(value.source) && typeof value.source.type === "string" && value.source.type.length > 0 &&
    typeof value.type === "string" && value.type.startsWith(`cf.${value.source.type}.`) &&
    value.type.length > `cf.${value.source.type}.`.length &&
    isRecord(value.payload) && isRecord(value.metadata) &&
    (value.metadata.eventTimestamp === undefined || typeof value.metadata.eventTimestamp === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function translate(event: CloudflareEvent): string {
  const lines: string[] = [];
  if (Object.hasOwn(BUILD_TITLES, event.type)) {
    lines.push(`[Cloudflare] ${BUILD_TITLES[event.type]}`);
    const build = event.payload;
    const trigger = isRecord(build.buildTriggerMetadata) ? build.buildTriggerMetadata : {};
    const fields = [
      ["Worker", event.source.workerName],
      ["ID do build", build.buildUuid],
      ["Status", build.status],
      ["Resultado", build.buildOutcome],
      ["Repositório", trigger.repoName],
      ["Conta do repositório", trigger.providerAccountName],
      ["Branch", trigger.branch],
      ["Commit", trigger.commitHash],
      ["Mensagem do commit", trigger.commitMessage],
      ["Autor", trigger.author],
    ];
    for (const [label, value] of fields) {
      if (typeof value === "string" && value) lines.push(`${label}: ${value}`);
    }
  } else {
    lines.push(`[Cloudflare] Evento: ${event.type}`);
  }
  if (event.metadata.eventTimestamp) lines.push(`Data e hora: ${event.metadata.eventTimestamp}`);
  lines.push("", "Dados do evento:", JSON.stringify(event, null, 2));
  return lines.join("\n");
}
