import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const MAX_SIGNATURE_AGE_SECONDS = 300;

export const goalApi: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.GOAL_API_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const header = request.headers.get("x-goal-signature");
    if (!header) return json(401, { error: "missing_signature_header" });

    const parts: Record<string, string> = {};
    for (const pair of header.split(",")) {
      const i = pair.indexOf("=");
      if (i > 0) parts[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) return json(401, { error: "invalid_signature_header" });

    if (Math.abs(Date.now() / 1000 - Number(t)) > MAX_SIGNATURE_AGE_SECONDS) {
      return json(401, { error: "stale_signature" });
    }

    const expected = await hmacHex(secret, `${t}.${rawBody}`);
    if (!constantTimeEqual(expected, v1)) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, ctx): Promise<Response> {
    const event = typeof payload.event === "string" ? payload.event : "";
    const eventId = typeof payload.id === "string" ? payload.id : "";
    if (!event) return ignored("unknown", eventId);

    ctx.waitUntil(
      forwardToPoke(`[Goal API] ${event}\n\n${JSON.stringify(payload, null, 2)}`, env),
    );
    return accepted(event, eventId);
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
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
