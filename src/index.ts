import type { DurableObjectNamespace, ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import { json } from "./utils";
import { SOURCES } from "./registry";
import { handleQueueBatch } from "./queue";

export interface Env {
  POKE_API_KEY: string;
  AGENTMAIL_WEBHOOK_SECRET: string;
  ANAKIN_WEBHOOK_SECRET: string;
  CIRCLEBACK_WEBHOOK_SECRET: string;
  COMPOSIO_WEBHOOK_SECRET: string;
  GOAL_API_WEBHOOK_SECRET: string;
  LOCATION_TRACKER_WEBHOOK_SECRET: string;
  PARALLEL_WEBHOOK_SECRET: string;
  PARALLEL_API_KEY: string;
  PLUGGY_WEBHOOK_SECRET: string;
  RAMBLE_WEBHOOK_SECRET: string;
  RESEND_WEBHOOK_SECRET: string;
  TODOIST_WEBHOOK_SECRET: string;
  TODOIST_API_TOKEN: string;
  TINYFISH_API_KEY: string;
  SLACK_DM_BUFFER?: DurableObjectNamespace;
  PARALLEL_API_URL?: string;
  POKE_API_URL?: string;
  SLACK_USER_ID?: string;
  SLACK_DM_DEBOUNCE_SECONDS?: string;
}

export { SlackDebounceBuffer } from "./debounce";

export interface SourceHandler {
  authorize?(rawBody: string, request: Request, env: Env): Promise<Response | null> | Response | null;
  handle(
    payload: Record<string, unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> | Response;
}

const ROUTES: Record<string, SourceHandler> = Object.fromEntries(
  Object.entries(SOURCES).map(([name, handler]) => [`/${name}`, handler]),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const handler = ROUTES[path];
    if (!handler) {
      return json(404, { error: "unknown_source", path });
    }

    const rawBody = await request.text();

    if (handler.authorize) {
      const authError = await handler.authorize(rawBody, request, env);
      if (authError) return authError;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { error: "invalid_json" });
    }

    return handler.handle(payload, env, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleQueueBatch(batch, env, ctx);
  },
};
