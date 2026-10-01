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
  "item/created": "Item criado e conectado com sucesso",
  "item/updated": "Item atualizado e sincronizado com sucesso",
  "item/deleted": "Item excluído",
  "item/error": "Ocorreu um erro no item",
  "item/waiting_user_input": "Item bloqueado aguardando informações do usuário",
  "item/login_succeeded": "Login do item realizado; coletando dados",
  "connector/status_updated": "Status do conector alterado",
  "transactions/deleted": "Transações excluídas após a mesclagem de itens",
  "transactions/created": "Novas transações disponíveis",
  "transactions/updated": "Transações atualizadas após a mesclagem de itens",
  "payment_intent/created": "Intenção de pagamento criada",
  "payment_intent/completed": "Intenção de pagamento concluída com sucesso",
  "payment_intent/waiting_payer_authorization":
    "Intenção de pagamento requer autorização adicional do pagador",
  "payment_intent/error": "Intenção de pagamento encerrada com erro",
  "payment_request/updated": "Status da solicitação de pagamento alterado",
  "scheduled_payment/created": "Autorização de pagamento agendado criada",
  "scheduled_payment/completed": "Pagamento agendado realizado",
  "scheduled_payment/error": "Pagamento agendado encerrado com erro",
  "scheduled_payment/canceled": "Pagamento agendado cancelado",
  "automatic_pix_payment/created": "Pagamento via Pix Automático agendado",
  "automatic_pix_payment/completed": "Pagamento via Pix Automático concluído",
  "automatic_pix_payment/error": "Pagamento via Pix Automático encerrado com erro",
  "automatic_pix_payment/canceled": "Pagamento via Pix Automático cancelado",
  "smart_transfer_preauthorization/completed":
    "Pré-autorização de transferência inteligente aprovada",
  "smart_transfer_preauthorization/error":
    "Falha na pré-autorização de transferência inteligente",
  "smart_transfer_payment/completed": "Pagamento de transferência inteligente concluído",
  "smart_transfer_payment/error": "Falha na liquidação do pagamento de transferência inteligente",
};

const ID_FIELDS = [
  ["itemId", "ID do item"],
  ["connectorId", "ID do conector"],
  ["paymentRequestId", "ID da solicitação de pagamento"],
  ["paymentIntentId", "ID da intenção de pagamento"],
  ["schedulePaymentId", "ID do pagamento agendado"],
  ["automaticPixPaymentId", "ID do pagamento via Pix Automático"],
  ["smartTransferPreauthorizationId", "ID da pré-autorização de transferência inteligente"],
  ["smartTransferPaymentId", "ID do pagamento de transferência inteligente"],
  ["transactionIds", "IDs das transações"],
] as const;

const DETAIL_FIELDS = [
  ["clientUserId", "ID do usuário do cliente"],
  ["triggeredBy", "Disparado por"],
  ["status", "Status"],
  ["createdTransactionsLink", "Link das transações criadas"],
] as const;

function translate(payload: Record<string, unknown>): string | null {
  const event = payload.event as string;
  const label = EVENT_LABELS[event];
  if (!label) return null;

  const lines: string[] = [`[Pluggy] ${label} (${event}).`];

  for (const [field, fieldLabel] of ID_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const rendered = Array.isArray(value)
      ? `${value.length} IDs${value.length <= 20 ? `: ${value.join(", ")}` : ""}`
      : String(value);
    lines.push(`${fieldLabel}: ${rendered}`);
  }

  for (const [field, fieldLabel] of DETAIL_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    lines.push(`${fieldLabel}: ${String(value)}`);
  }

  const error = payload.error;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; description?: unknown; detail?: unknown };
    lines.push(
      `Erro: ${[e.code, e.description, e.detail]
        .filter((v) => typeof v === "string" && v)
        .join(" — ")}`,
    );
  } else if (typeof payload.error === "string") {
    lines.push(`Erro: ${payload.error}`);
  }

  return lines.join("\n");
}
