import { Webhook, WebhookVerificationError } from "standardwebhooks";
import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json, stripHtml } from "../utils";

const SUPPORTED_EVENTS = new Set([
  "message.received",
  "message.sent",
  "message.delivered",
]);

export const agentmail: SourceHandler = {
  authorize(rawBody, request, env): Response | null {
    const secret = env.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const headers = {
      "webhook-id": request.headers.get("svix-id") ?? "",
      "webhook-timestamp": request.headers.get("svix-timestamp") ?? "",
      "webhook-signature": request.headers.get("svix-signature") ?? "",
    };
    if (
      !headers["webhook-id"] ||
      !headers["webhook-timestamp"] ||
      !headers["webhook-signature"]
    ) {
      return json(401, { error: "missing_signature_headers" });
    }

    try {
      new Webhook(secret).verify(rawBody, headers);
      return null;
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return json(401, { error: "invalid_signature" });
      }
      throw err;
    }
  },

  async handle(payload, env, ctx): Promise<Response> {
    const eventType = typeof payload.event_type === "string" ? payload.event_type : "";
    const eventId = typeof payload.event_id === "string" ? payload.event_id : "";

    if (!SUPPORTED_EVENTS.has(eventType)) {
      return ignored(eventType, eventId);
    }

    const message = translate(eventType, payload);
    if (!message) {
      return ignored(eventType, eventId);
    }

    ctx.waitUntil(forwardToPoke(message, env));
    return accepted(eventType, eventId);
  },
};

function translate(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType === "message.received") return translateReceived(payload);
  if (eventType === "message.sent") return translateSent(payload);
  if (eventType === "message.delivered") return translateDelivered(payload);
  return null;
}

interface ReceivedMessage {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  inbox_id?: string;
  thread_id?: string;
  message_id?: string;
  timestamp?: string;
}

function translateReceived(payload: Record<string, unknown>): string | null {
  const msg = (payload.message ?? {}) as ReceivedMessage;
  if (!msg || typeof msg !== "object") return null;

  const toList = msg.to ?? [];
  const to = toList.join(", ");
  const inboxEmail = toList[0] ?? msg.inbox_id ?? "não informada";
  const cc = msg.cc && msg.cc.length ? `\nCc: ${msg.cc.join(", ")}` : "";
  const body = msg.text || msg.preview || stripHtml(msg.html) || "(sem conteúdo)";
  const lines = [
    `[AgentMail] Novo e-mail recebido na sua caixa de entrada do AgentMail ${inboxEmail}:`,
    `De: ${msg.from ?? "não informado"}`,
    `Para: ${to || "não informado"}`,
    ...(cc ? [cc.trimStart()] : []),
    `Assunto: ${msg.subject ?? "(sem assunto)"}`,
    `Data e hora: ${msg.timestamp ?? "não informadas"}`,
    `Conversa: ${msg.thread_id ?? "?"}`,
    "",
    body,
  ];
  return lines.join("\n");
}

interface SendEvent {
  inbox_id?: string;
  thread_id?: string;
  message_id?: string;
  timestamp?: string;
  recipients?: string[];
}

function translateSent(payload: Record<string, unknown>): string | null {
  const send = (payload.send ?? {}) as SendEvent;
  if (!send || typeof send !== "object") return null;
  const recipients = (send.recipients ?? []).join(", ");
  return [
    `[AgentMail] Sua caixa de entrada do AgentMail ${send.inbox_id ?? "não informada"} enviou um e-mail:`,
    `Destinatários: ${recipients || "não informados"}`,
    `Conversa: ${send.thread_id ?? "?"}`,
    `Data e hora: ${send.timestamp ?? "não informadas"}`,
  ].join("\n");
}

function translateDelivered(payload: Record<string, unknown>): string | null {
  const delivery = (payload.delivery ?? {}) as SendEvent;
  if (!delivery || typeof delivery !== "object") return null;
  const recipients = (delivery.recipients ?? []).join(", ");
  return [
    `[AgentMail] O e-mail enviado pela sua caixa de entrada do AgentMail ${delivery.inbox_id ?? "não informada"} foi entregue ao servidor de e-mail do destinatário:`,
    `Destinatários: ${recipients || "não informados"}`,
    `Conversa: ${delivery.thread_id ?? "?"}`,
    `Data e hora: ${delivery.timestamp ?? "não informadas"}`,
  ].join("\n");
}
