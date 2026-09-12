import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

export const pluggy: SourceHandler = {
  authorize(_rawBody, request, env): Response | null {
    const secret = env.PLUGGY_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const header = request.headers.get("x-webhook-secret");
    if (!header) return json(401, { error: "missing_secret_header" });
    if (!constantTimeEqual(header, secret)) {
      return json(401, { error: "invalid_secret" });
    }
    return null;
  },

  async handle(payload, env, ctx): Promise<Response> {
    const event = typeof payload.event === "string" ? payload.event : "";
    const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
    if (!event) return ignored("unknown", eventId);

    const message = translate(payload);
    if (!message) return ignored(event, eventId);

    ctx.waitUntil(forwardToPoke(message, env));
    return accepted(event, eventId);
  },
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const EVENT_LABELS: Record<string, string> = {
  "item/created": "Item was created and connected successfully",
  "item/updated": "Item was updated and synced successfully",
  "item/deleted": "Item was deleted",
  "item/error": "Item encountered an error",
  "item/waiting_user_input": "Item is blocked waiting for user input",
  "item/login_succeeded": "Item logged in and is collecting data",
  "connector/status_updated": "Connector changed status",
  "transactions/deleted": "Transactions were deleted after item merge",
  "transactions/created": "New transactions are available",
  "transactions/updated": "Transactions were updated after item merge",
  "payment_intent/created": "Payment intent was created",
  "payment_intent/completed": "Payment intent completed successfully",
  "payment_intent/waiting_payer_authorization":
    "Payment intent needs additional payer authorization",
  "payment_intent/error": "Payment intent finished with an error",
  "payment_request/updated": "Payment request status changed",
  "scheduled_payment/created": "Scheduled payment authorization was created",
  "scheduled_payment/completed": "A scheduled payment was made",
  "scheduled_payment/error": "Scheduled payment finished with an error",
  "scheduled_payment/canceled": "Scheduled payment was canceled",
  "automatic_pix_payment/created": "Automatic PIX payment was scheduled",
  "automatic_pix_payment/completed": "Automatic PIX payment completed",
  "automatic_pix_payment/error": "Automatic PIX payment ended with an error",
  "automatic_pix_payment/canceled": "Automatic PIX payment was canceled",
  "smart_transfer_preauthorization/completed":
    "Smart transfer preauthorization was approved",
  "smart_transfer_preauthorization/error":
    "Smart transfer preauthorization failed",
  "smart_transfer_payment/completed": "Smart transfer payment completed",
  "smart_transfer_payment/error": "Smart transfer payment failed to settle",
};

const ID_FIELDS = [
  "itemId",
  "connectorId",
  "paymentRequestId",
  "paymentIntentId",
  "schedulePaymentId",
  "automaticPixPaymentId",
  "smartTransferPreauthorizationId",
  "smartTransferPaymentId",
  "transactionIds",
];

const DETAIL_FIELDS = [
  "clientUserId",
  "triggeredBy",
  "status",
  "createdTransactionsLink",
];

function translate(payload: Record<string, unknown>): string | null {
  const event = payload.event as string;
  const label = EVENT_LABELS[event];
  if (!label) return null;

  const lines: string[] = [`[Pluggy] ${label} (${event}).`];

  for (const field of ID_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const rendered = Array.isArray(value)
      ? `${value.length} ids${value.length <= 20 ? `: ${value.join(", ")}` : ""}`
      : String(value);
    lines.push(`${field}: ${rendered}`);
  }

  for (const field of DETAIL_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    lines.push(`${field}: ${String(value)}`);
  }

  const error = payload.error;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; description?: unknown; detail?: unknown };
    lines.push(
      `Error: ${[e.code, e.description, e.detail]
        .filter((v) => typeof v === "string" && v)
        .join(" — ")}`,
    );
  } else if (typeof payload.error === "string") {
    lines.push(`Error: ${payload.error}`);
  }

  return lines.join("\n");
}
