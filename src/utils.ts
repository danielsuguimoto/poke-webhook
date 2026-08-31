import type { Env } from "./index";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function authorize(request: Request, env: Env): Response | null {
  const headerName = env.WEBHOOK_SECRET_HEADER || "X-Webhook-Secret";
  const expected = env.WEBHOOK_SECRET;
  if (!expected) return json(500, { error: "missing_webhook_secret" });

  const provided = request.headers.get(headerName);
  if (!provided) return json(401, { error: "missing_secret" });

  const expectedBytes = new TextEncoder().encode(expected);
  const providedBytes = new TextEncoder().encode(provided);
  if (expectedBytes.byteLength !== providedBytes.byteLength) {
    return json(401, { error: "invalid_secret" });
  }
  let diff = 0;
  for (let i = 0; i < expectedBytes.byteLength; i++) {
    diff |= expectedBytes[i] ^ providedBytes[i];
  }
  return diff === 0 ? null : json(401, { error: "invalid_secret" });
}

export function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
