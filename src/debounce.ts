import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "./index";
import { forwardToPoke } from "./poke";
import { json } from "./utils";

const MESSAGES_KEY = "messages";
const ATTEMPTS_KEY = "attempts";
const MAX_FORWARD_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60_000;

export const DEFAULT_DEBOUNCE_MS = 60_000;

export function debounceWindowMs(env: Env): number {
  const seconds = Number.parseInt(env.SLACK_DM_DEBOUNCE_SECONDS ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_DEBOUNCE_MS;
}

// One Durable Object instance per Slack conversation (idFromName on the
// channel/conversation key), so buffers never mix across conversations and
// requests/alarm for a conversation are serialized: an append resets the
// pending alarm (trailing-edge quiet window) and a cancel always wins over an
// alarm that has not fired yet — a fired alarm re-checks storage before
// sending, so a cancel processed first still suppresses the forward.
export class SlackDebounceBuffer {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/append") {
      const body = await request.json().catch(() => null) as { message?: unknown; windowMs?: unknown } | null;
      if (!body || typeof body.message !== "string" || !body.message) {
        return json(400, { error: "invalid_payload" });
      }
      const messages = await this.messages();
      messages.push(body.message);
      const windowMs = typeof body.windowMs === "number" && body.windowMs > 0
        ? body.windowMs
        : DEFAULT_DEBOUNCE_MS;
      await this.ctx.storage.put(MESSAGES_KEY, messages);
      await this.ctx.storage.put(ATTEMPTS_KEY, 0);
      await this.ctx.storage.setAlarm(Date.now() + windowMs);
      return json(202, { status: "buffered", buffered: messages.length });
    }
    if (request.method === "POST" && path === "/cancel") {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return json(202, { status: "cancelled" });
    }
    return json(404, { error: "unknown_path" });
  }

  async alarm(): Promise<void> {
    const messages = await this.messages();
    if (messages.length === 0) return;
    const text = messages.length === 1
      ? messages[0]
      : `[Composio] ${messages.length} mensagens diretas do Slack agregadas:\n\n${messages.join("\n\n---\n\n")}`;
    const delivered = await forwardToPoke(text, this.env);
    if (delivered) {
      await this.dropSent(messages.length);
      return;
    }
    const attempts = ((await this.ctx.storage.get<number>(ATTEMPTS_KEY)) ?? 0) + 1;
    if (attempts >= MAX_FORWARD_ATTEMPTS) {
      console.error(`Slack DM debounce: dropping ${messages.length} buffered message(s) after ${attempts} failed Poke forwards`);
      await this.dropSent(messages.length);
      return;
    }
    await this.ctx.storage.put(ATTEMPTS_KEY, attempts);
    await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
  }

  // Removes the `sentCount` messages that were just forwarded, inside a
  // transaction so messages appended while the Poke request was in flight are
  // preserved instead of being wiped.
  private async dropSent(sentCount: number): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await this.messages();
      await this.ctx.storage.put(MESSAGES_KEY, current.slice(sentCount));
      await this.ctx.storage.delete(ATTEMPTS_KEY);
    });
  }

  private async messages(): Promise<string[]> {
    const stored = await this.ctx.storage.get<string[]>(MESSAGES_KEY);
    return Array.isArray(stored) ? stored : [];
  }
}
