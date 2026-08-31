import type { Env } from "./index";
import { json } from "./utils";

const DEFAULT_POKE_API_URL = "https://poke.com/api/v1/inbound/api-message";

export async function forwardToPoke(message: string, env: Env): Promise<void> {
  const url = env.POKE_API_URL || DEFAULT_POKE_API_URL;
  if (!env.POKE_API_KEY) {
    console.error("POKE_API_KEY not configured; dropping message");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.POKE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Poke API error ${res.status}: ${text}`);
  }
}

export function accepted(eventType: string, eventId: string): Response {
  return json(200, { status: "accepted", event_type: eventType, event_id: eventId });
}

export function ignored(eventType: string, eventId: string): Response {
  return json(202, { status: "ignored", event_type: eventType, event_id: eventId });
}
