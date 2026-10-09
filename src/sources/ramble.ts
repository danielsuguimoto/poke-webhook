import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10_000;

// Best-effort deduplication within a worker isolate: Ramble retries failed
// deliveries up to 3 times with backoff, resending the same recording_id.
const seenRecordings = new Map<string, number>();

function isDuplicate(recordingId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenRecordings) {
    if (now - ts > DEDUP_TTL_MS) seenRecordings.delete(id);
  }
  return seenRecordings.has(recordingId);
}

function markSeen(recordingId: string): void {
  if (seenRecordings.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenRecordings.keys().next().value;
    if (oldest !== undefined) seenRecordings.delete(oldest);
  }
  seenRecordings.set(recordingId, Date.now());
}

export const ramble: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.RAMBLE_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const signature = request.headers.get("x-webhook-signature");
    if (!signature) return json(401, { error: "missing_signature_header" });

    const expected = `sha256=${await hmacHex(secret, rawBody)}`;
    if (!constantTimeEqual(expected, signature)) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, _ctx): Promise<Response> {
    if (!payload || typeof payload !== "object") {
      return json(400, { error: "invalid_payload" });
    }
    const recordingId = typeof payload.recording_id === "string" ? payload.recording_id : "";
    if (!recordingId) return json(400, { error: "invalid_payload" });

    const isTest = payload.test === true || recordingId.startsWith("test-");
    if (!isTest && isDuplicate(recordingId)) return ignored("transcription.completed", recordingId);

    // Forward synchronously: on Poke failure we return 503 so Ramble retries,
    // and the recording is only marked seen after a confirmed delivery.
    const delivered = await forwardToPoke(translate(payload, recordingId, isTest), env);
    if (!delivered) return json(503, { error: "poke_forward_failed" });
    if (!isTest) markSeen(recordingId);
    return accepted("transcription.completed", recordingId);
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

function translate(payload: Record<string, unknown>, recordingId: string, isTest: boolean): string {
  const lines: string[] = [
    isTest ? "[Ramble] Webhook de teste recebido:" : "[Ramble] Nova transcrição recebida:",
    `ID da gravação: ${recordingId}`,
    `Data e hora: ${str(payload.created_at) || "não informadas"}`,
  ];

  if (typeof payload.duration === "number") {
    lines.push(`Duração: ${payload.duration.toFixed(1)} s`);
  }
  if (str(payload.device_id)) {
    lines.push(`Dispositivo: ${str(payload.device_id)}`);
  }

  const transcription = str(payload.transcription);
  lines.push("", "Transcrição:", transcription || "(sem conteúdo)");

  return lines.join("\n");
}
