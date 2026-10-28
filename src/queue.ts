import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { Env } from "./index";
import { SOURCES } from "./registry";

export interface QueueEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
  timestamp?: number | string;
}

export type QueueOutcome = "ack" | "retry";
export type QueueEventDispatcher = (event: QueueEvent, env: Env, ctx: ExecutionContext) => Promise<QueueOutcome>;

export const QUEUE_DISPATCHERS: Record<string, QueueEventDispatcher> = {
  "*": dispatchToSource,
};

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
  const dispatcher = QUEUE_DISPATCHERS[batch.queue] ?? QUEUE_DISPATCHERS["*"];
  for (const message of batch.messages) {
    try {
      const event = parseQueueEvent(message.body);
      if (!event) {
        console.error(`queue ${batch.queue}: dropping malformed message ${message.id}`);
        message.ack();
        continue;
      }
      if (await dispatcher(event, env, ctx) === "retry") message.retry();
      else message.ack();
    } catch (err) {
      console.error(`queue ${batch.queue}: message ${message.id} failed: ${err}`);
      message.retry();
    }
  }
  batch.ackAll();
}

async function dispatchToSource(event: QueueEvent, env: Env, ctx: ExecutionContext): Promise<QueueOutcome> {
  const handler = SOURCES[event.source];
  if (!handler) {
    console.error(`dropping event for unknown source "${event.source}" (type "${event.type}")`);
    return "ack";
  }
  const response = await handler.handle(event.data, env, ctx);
  if (response.status >= 500) return "retry";
  if (response.status >= 400) {
    console.error(`dropping event "${event.type}" for source "${event.source}": handler returned ${response.status}`);
  }
  return "ack";
}

function parseQueueEvent(body: unknown): QueueEvent | null {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (typeof value.source !== "string" || !value.source) return null;
  if (typeof value.type !== "string" || !value.type) return null;
  if (!isRecord(value.data)) return null;
  if (value.timestamp !== undefined && typeof value.timestamp !== "number" && typeof value.timestamp !== "string") {
    return null;
  }
  return { source: value.source, type: value.type, data: value.data, timestamp: value.timestamp as number | string | undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
