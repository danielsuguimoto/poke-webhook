import type { ExecutionContext } from "@cloudflare/workers-types";
import { json } from "./utils";
import { agentmail } from "./sources/agentmail";
import { circleback } from "./sources/circleback";
import { pluggy } from "./sources/pluggy";
import { todoist } from "./sources/todoist";

export interface Env {
  POKE_API_KEY: string;
  AGENTMAIL_WEBHOOK_SECRET: string;
  CIRCLEBACK_WEBHOOK_SECRET: string;
  PLUGGY_WEBHOOK_SECRET: string;
  TODOIST_WEBHOOK_SECRET: string;
  TODOIST_API_TOKEN: string;
  POKE_API_URL?: string;
}

export interface SourceHandler {
  authorize?(rawBody: string, request: Request, env: Env): Promise<Response | null> | Response | null;
  handle(
    payload: Record<string, unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> | Response;
}

const ROUTES: Record<string, SourceHandler> = {
  "/agentmail": agentmail,
  "/circleback": circleback,
  "/pluggy": pluggy,
  "/todoist": todoist,
};

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
};
