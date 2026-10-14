import { Webhook, WebhookVerificationError } from "standardwebhooks";
import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json, stripHtml } from "../utils";

const RECEIVED_HEADERS: Record<string, string> = {
  "message.received": "Novo e-mail recebido",
  "message.received.spam": "E-mail recebido classificado como spam",
  "message.received.blocked": "E-mail recebido bloqueado pela lista de bloqueio",
  "message.received.unauthenticated": "E-mail recebido sem autenticação",
};

const CALENDAR_ACTIONS: Record<string, string> = {
  "calendar.event.created": "criado",
  "calendar.event.updated": "atualizado",
  "calendar.event.deleted": "excluído",
  "calendar.event.responded": "respondido",
  "calendar.event.starting": "iniciado",
  "calendar.event.ending": "encerrado",
};

const SUPPORTED_EVENTS = new Set([
  ...Object.keys(RECEIVED_HEADERS),
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "message.opened",
  "message.security.completed",
  "domain.verified",
  ...Object.keys(CALENDAR_ACTIONS),
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
  const receivedHeader = RECEIVED_HEADERS[eventType];
  if (receivedHeader) return translateReceived(payload, receivedHeader, eventType === "message.received");
  if (eventType === "message.sent") return translateSent(payload);
  if (eventType === "message.delivered") return translateDelivered(payload);
  if (eventType === "message.bounced") return translateBounced(payload);
  if (eventType === "message.complained") return translateComplained(payload);
  if (eventType === "message.rejected") return translateRejected(payload);
  if (eventType === "message.opened") return translateOpened(payload);
  if (eventType === "message.security.completed") return translateSecurityCompleted(payload);
  if (eventType === "domain.verified") return translateDomainVerified(payload);
  const calendarAction = CALENDAR_ACTIONS[eventType];
  if (calendarAction) return translateCalendarEvent(payload, calendarAction);
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

function translateReceived(payload: Record<string, unknown>, header: string, trusted: boolean): string | null {
  const msg = (payload.message ?? {}) as ReceivedMessage;
  if (!msg || typeof msg !== "object") return null;

  const toList = msg.to ?? [];
  const to = toList.join(", ");
  const inboxEmail = toList[0] ?? msg.inbox_id ?? "não informada";
  const cc = msg.cc && msg.cc.length ? `\nCc: ${msg.cc.join(", ")}` : "";
  // Flagged messages (spam/blocked/unauthenticated) can carry hostile
  // instructions in any sender-controlled field, so only our own inbox
  // addressing and timestamps are forwarded — never content or identities.
  if (!trusted) {
    return [
      `[AgentMail] ${header} na sua caixa de entrada do AgentMail ${inboxEmail}:`,
      `Para: ${to || "não informado"}`,
      `Data e hora: ${msg.timestamp ?? "não informadas"}`,
      `Conversa: ${msg.thread_id ?? "?"}`,
      "",
      "(conteúdo omitido por segurança)",
    ].join("\n");
  }
  const body = msg.text || msg.preview || stripHtml(msg.html) || "(sem conteúdo)";
  const lines = [
    `[AgentMail] ${header} na sua caixa de entrada do AgentMail ${inboxEmail}:`,
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
  recipients?: unknown[];
}

function recipientList(recipients: unknown[] | undefined): string {
  return (recipients ?? [])
    .map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const { address, status } = r as { address?: string; status?: string };
        return status ? `${address ?? "não informado"} (${status})` : (address ?? "não informado");
      }
      return "não informado";
    })
    .join(", ");
}

function translateSent(payload: Record<string, unknown>): string | null {
  const send = (payload.send ?? {}) as SendEvent;
  if (!send || typeof send !== "object") return null;
  const recipients = recipientList(send.recipients);
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
  const recipients = recipientList(delivery.recipients);
  return [
    `[AgentMail] O e-mail enviado pela sua caixa de entrada do AgentMail ${delivery.inbox_id ?? "não informada"} foi entregue ao servidor de e-mail do destinatário:`,
    `Destinatários: ${recipients || "não informados"}`,
    `Conversa: ${delivery.thread_id ?? "?"}`,
    `Data e hora: ${delivery.timestamp ?? "não informadas"}`,
  ].join("\n");
}

interface BounceEvent extends SendEvent {
  type?: string;
  sub_type?: string;
}

function bounceType(type?: string, subType?: string): string {
  if (!type) return "não informado";
  return subType ? `${type} — ${subType}` : type;
}

function translateBounced(payload: Record<string, unknown>): string | null {
  const bounce = (payload.bounce ?? {}) as BounceEvent;
  if (!bounce || typeof bounce !== "object") return null;
  const recipients = recipientList(bounce.recipients);
  return [
    `[AgentMail] O e-mail enviado pela sua caixa de entrada do AgentMail ${bounce.inbox_id ?? "não informada"} foi devolvido (bounce):`,
    `Tipo: ${bounceType(bounce.type, bounce.sub_type)}`,
    `Destinatários: ${recipients || "não informados"}`,
    `Conversa: ${bounce.thread_id ?? "?"}`,
    `Data e hora: ${bounce.timestamp ?? "não informadas"}`,
  ].join("\n");
}

function translateComplained(payload: Record<string, unknown>): string | null {
  const complaint = (payload.complaint ?? {}) as BounceEvent;
  if (!complaint || typeof complaint !== "object") return null;
  const recipients = recipientList(complaint.recipients);
  return [
    `[AgentMail] Um destinatário marcou como spam o e-mail enviado pela sua caixa de entrada do AgentMail ${complaint.inbox_id ?? "não informada"}:`,
    `Tipo: ${bounceType(complaint.type, complaint.sub_type)}`,
    `Destinatários: ${recipients || "não informados"}`,
    `Conversa: ${complaint.thread_id ?? "?"}`,
    `Data e hora: ${complaint.timestamp ?? "não informadas"}`,
  ].join("\n");
}

interface RejectEvent extends SendEvent {
  reason?: string;
}

function translateRejected(payload: Record<string, unknown>): string | null {
  const reject = (payload.reject ?? {}) as RejectEvent;
  if (!reject || typeof reject !== "object") return null;
  return [
    `[AgentMail] O e-mail da sua caixa de entrada do AgentMail ${reject.inbox_id ?? "não informada"} foi rejeitado antes do envio:`,
    `Motivo: ${reject.reason ?? "não informado"}`,
    `Conversa: ${reject.thread_id ?? "?"}`,
    `Data e hora: ${reject.timestamp ?? "não informadas"}`,
  ].join("\n");
}

function translateOpened(payload: Record<string, unknown>): string | null {
  const open = (payload.open ?? {}) as SendEvent;
  if (!open || typeof open !== "object") return null;
  return [
    `[AgentMail] O e-mail enviado pela sua caixa de entrada do AgentMail ${open.inbox_id ?? "não informada"} foi aberto pela primeira vez:`,
    `Conversa: ${open.thread_id ?? "?"}`,
    `Data e hora: ${open.timestamp ?? "não informadas"}`,
  ].join("\n");
}

interface AgentArmorResult {
  status?: string;
  verdict?: string;
  reason?: string;
  model?: string;
  completed_at?: string;
}

interface SecurityMessage {
  inbox_id?: string;
  message_id?: string;
  agent_armor?: AgentArmorResult;
}

function translateSecurityCompleted(payload: Record<string, unknown>): string | null {
  const msg = (payload.message ?? {}) as SecurityMessage;
  if (!msg || typeof msg !== "object") return null;
  const armor = msg.agent_armor ?? {};
  return [
    `[AgentMail] O Agent Armor concluiu a análise de um e-mail recebido na sua caixa de entrada do AgentMail ${msg.inbox_id ?? "não informada"}:`,
    `Veredito: ${armor.verdict ?? "não informado"}`,
    `Motivo: ${armor.reason ?? "não informado"}`,
    `Mensagem: ${msg.message_id ?? "?"}`,
    `Data e hora: ${armor.completed_at ?? "não informadas"}`,
  ].join("\n");
}

interface DomainEvent {
  domain_id?: string;
  status?: string;
  updated_at?: string;
}

function translateDomainVerified(payload: Record<string, unknown>): string | null {
  const domain = (payload.domain ?? {}) as DomainEvent;
  if (!domain || typeof domain !== "object") return null;
  return [
    `[AgentMail] O domínio ${domain.domain_id ?? "não informado"} foi verificado com sucesso:`,
    `Status: ${domain.status ?? "não informado"}`,
    `Data e hora: ${domain.updated_at ?? "não informadas"}`,
  ].join("\n");
}

interface CalendarAttendee {
  email?: string;
  name?: string;
  status?: string;
}

interface CalendarEvent {
  event_id?: string;
  title?: string;
  location?: string;
  status?: string;
  start_at?: string;
  end_at?: string;
  attendees?: CalendarAttendee[];
}

function attendeeList(attendees: CalendarAttendee[] | undefined): string[] {
  return (attendees ?? [])
    .filter((a) => a && typeof a === "object")
    .map((a) => {
      const name = a.name && a.email ? `${a.name} <${a.email}>` : (a.name ?? a.email ?? "não informado");
      return a.status ? `${name} (${a.status})` : name;
    });
}

function translateCalendarEvent(payload: Record<string, unknown>, action: string): string | null {
  const event = (payload.calendar_event ?? {}) as CalendarEvent;
  if (!event || typeof event !== "object") return null;
  const inboxId = typeof payload.inbox_id === "string" ? payload.inbox_id : "não informada";
  const scheduledAt = typeof payload.scheduled_at === "string" ? payload.scheduled_at : "não informadas";
  return [
    `[AgentMail] Um evento de calendário foi ${action} na sua caixa de entrada do AgentMail ${inboxId}:`,
    `Evento: ${event.title ?? "sem título"}`,
    ...(event.status ? [`Status: ${event.status}`] : []),
    ...(event.location ? [`Local: ${event.location}`] : []),
    ...attendeeList(event.attendees).map((a) => `Participante: ${a}`),
    `Início: ${event.start_at ?? "não informado"}`,
    `Fim: ${event.end_at ?? "não informado"}`,
    `Data e hora: ${scheduledAt}`,
  ].join("\n");
}
