import type { ExecutionContext } from "@cloudflare/workers-types";
import { authorize, json } from "./utils";
import { agentmail } from "./sources/agentmail";

export interface Env {
  POKE_API_KEY: string;
  WEBHOOK_SECRET: string;
  POKE_API_URL?: string;
  WEBHOOK_SECRET_HEADER?: string;
}

export interface SourceHandler {
  handle(
    payload: Record<string, unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> | Response;
}

const ROUTES: Record<string, SourceHandler> = {
  "/agentmail": agentmail,
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

    const authError = authorize(request, env);
    if (authError) return authError;

    let payload: Record<string, unknown>;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    return handler.handle(payload, env, ctx);
  },
};
