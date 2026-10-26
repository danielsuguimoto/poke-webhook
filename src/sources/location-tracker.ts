import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

interface LocationTrackerPayload {
  event: "enter" | "exit" | "test";
  geofence: { id: string; name: string; lat: number; lon: number; radius_m: number };
  location: { lat: number; lon: number; acc: number | null; tst: number; device: string | null } | null;
  message: string;
  timestamp: number;
}

export const locationTracker: SourceHandler = {
  authorize(_rawBody, request, env): Response | null {
    const secret = env.LOCATION_TRACKER_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !constantTimeEqual(secret, token)) {
      return json(401, { error: "invalid_bearer_token" });
    }
    return null;
  },

  handle(payload, env, ctx): Response {
    if (!isRecord(payload) || typeof payload.event !== "string" || !payload.event) {
      return json(400, { error: "invalid_payload" });
    }
    if (!["enter", "exit", "test"].includes(payload.event)) return ignored(payload.event, "");
    if (!isPayload(payload)) return json(400, { error: "invalid_payload" });

    ctx.waitUntil(forwardToPoke(translate(payload), env));
    return accepted(payload.event, payload.geofence.id);
  },
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0 &&
    Number.isFinite(new Date(value * 1000).getTime());
}

function hasCoordinates(value: Record<string, unknown>): boolean {
  return isNumber(value.lat) && Math.abs(value.lat) <= 90 &&
    isNumber(value.lon) && Math.abs(value.lon) <= 180;
}

function isPayload(value: Record<string, unknown>): value is Record<string, unknown> & LocationTrackerPayload {
  const fence = value.geofence;
  const loc = value.location;
  return isRecord(fence) &&
    typeof fence.id === "string" && !!fence.id &&
    typeof fence.name === "string" && !!fence.name &&
    hasCoordinates(fence) && isNumber(fence.radius_m) && fence.radius_m > 0 &&
    typeof value.message === "string" && isTimestamp(value.timestamp) &&
    (loc === null || (isRecord(loc) && hasCoordinates(loc) &&
      (loc.acc === null || (isNumber(loc.acc) && loc.acc >= 0)) &&
      isTimestamp(loc.tst) && (loc.device === null || typeof loc.device === "string")));
}

function translate(payload: LocationTrackerPayload): string {
  const { event, geofence, location, message, timestamp } = payload;
  const title = event === "enter" ? "Entrada na área" : event === "exit" ? "Saída da área" : "Teste de notificação da área";
  const lines = [
    `[Location Tracker] ${title} "${geofence.name}":`,
    ...(event === "test" ? ["Este é apenas um teste; não indica uma entrada ou saída real."] : []),
    `Evento: ${event}`,
    `ID da área: ${geofence.id}`,
    `Centro da área: ${geofence.lat}, ${geofence.lon} — Raio: ${geofence.radius_m} m`,
    `Data e hora do evento: ${new Date(timestamp * 1000).toISOString()}`,
    `Mensagem: ${message}`,
  ];
  if (location) {
    lines.push(
      `Localização: ${location.lat}, ${location.lon}`,
      `Precisão: ${location.acc === null ? "não informada" : `${location.acc} m`}`,
      `Dispositivo: ${location.device || "não informado"}`,
      `Data e hora da localização: ${new Date(location.tst * 1000).toISOString()}`,
    );
  } else {
    lines.push("Localização: não informada");
  }
  return lines.join("\n");
}
