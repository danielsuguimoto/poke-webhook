import { Webhook, WebhookVerificationError } from "standardwebhooks";
import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10_000;

// Best-effort deduplication within a worker isolate, keyed on the event's
// type, webhook `created_at` and object id: Resend retries a delivery with the
// same svix-id and an identical body, while distinct events differ.
const seenEvents = new Map<string, number>();
// dedup key -> in-flight forward, so concurrent duplicate deliveries
// share the first attempt's outcome instead of being acknowledged early.
const inFlight = new Map<string, Promise<boolean>>();

function markSeen(key: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(key)) return false;
  if (seenEvents.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenEvents.keys().next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  seenEvents.set(key, now);
  return true;
}

const EMAIL_HEADERS: Record<string, string> = {
  "email.sent": "E-mail enviado",
  "email.delivered": "E-mail entregue ao servidor do destinatário",
  "email.delivery_delayed": "Entrega de e-mail atrasada",
  "email.complained": "E-mail marcado como spam pelo destinatário",
  "email.bounced": "E-mail devolvido (bounce)",
  "email.failed": "Falha no envio do e-mail",
  "email.opened": "E-mail aberto",
  "email.clicked": "Link de e-mail clicado",
  "email.received": "Novo e-mail recebido",
  "email.scheduled": "E-mail agendado",
  "email.suppressed": "E-mail suprimido",
};

const OBJECT_ACTIONS: Record<string, [string, string]> = {
  "domain.created": ["Domínio", "criado"],
  "domain.updated": ["Domínio", "atualizado"],
  "domain.deleted": ["Domínio", "excluído"],
  "contact.created": ["Contato", "criado"],
  "contact.updated": ["Contato", "atualizado"],
  "contact.deleted": ["Contato", "excluído"],
  "contact.topics.updated": ["Contato", "com tópicos atualizados"],
  "suppression.added": ["Endereço de e-mail", "adicionado à lista de supressão"],
  "suppression.removed": ["Endereço de e-mail", "removido da lista de supressão"],
  "topic.created": ["Tópico", "criado"],
  "topic.updated": ["Tópico", "atualizado"],
  "topic.deleted": ["Tópico", "excluído"],
  "inbox.created": ["Caixa de entrada", "criada"],
  "inbox.updated": ["Caixa de entrada", "atualizada"],
  "inbox.deleted": ["Caixa de entrada", "excluída"],
  "inbox.thread.created": ["Conversa", "criada na caixa de entrada"],
  "inbox.thread.folder.updated": ["Conversa", "movida de pasta"],
  "inbox.thread.assigned": ["Conversa", "atribuída"],
  "inbox.thread.unassigned": ["Conversa", "desatribuída"],
};

const SUPPORTED_EVENTS = new Set([
  ...Object.keys(EMAIL_HEADERS),
  ...Object.keys(OBJECT_ACTIONS),
]);

// Resend signs deliveries via Svix: `svix-id`, `svix-timestamp` and
// `svix-signature` headers over the raw body, verified with the endpoint's
// `whsec_...` signing secret.
export const resend: SourceHandler = {
  authorize(rawBody, request, env): Response | null {
    const secret = env.RESEND_WEBHOOK_SECRET;
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

  async handle(payload, env, _ctx): Promise<Response> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "invalid_payload" });
    }
    const eventType = typeof payload.type === "string" ? payload.type : "";
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};

    if (!SUPPORTED_EVENTS.has(eventType)) {
      return ignored(eventType || "unknown", "");
    }

    const dedupKey = [
      eventType,
      str(payload.created_at),
      str(data.email_id) || str(data.id) || str(data.domain_id) || str(data.contact_id) || str(data.inbox_id),
    ].join(":");

    const pending = inFlight.get(dedupKey);
    if (pending) {
      const delivered = await pending;
      return delivered
        ? ignored(eventType, dedupKey)
        : json(503, { error: "poke_forward_failed" });
    }
    if (!markSeen(dedupKey)) return ignored(eventType, dedupKey);

    const forward = forwardToPoke(translate(eventType, payload, data), env);
    inFlight.set(dedupKey, forward);
    const delivered = await forward;
    inFlight.delete(dedupKey);
    if (!delivered) {
      seenEvents.delete(dedupKey);
      return json(503, { error: "poke_forward_failed" });
    }
    return accepted(eventType, str(data.email_id) || dedupKey);
  },
};

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "";
}

function translate(eventType: string, payload: Record<string, unknown>, data: Record<string, unknown>): string {
  const emailHeader = EMAIL_HEADERS[eventType];
  if (emailHeader) return translateEmail(emailHeader, payload, data);

  const [objectName, action] = OBJECT_ACTIONS[eventType];
  const lines = [`[Resend] ${objectName} ${action}:`];
  const name = str(data.name) || str(data.email) || str(data.id) || str(data.inbox_id);
  if (name) lines.push(`${objectName}: ${name}`);
  lines.push(`Data e hora: ${str(payload.created_at) || "não informadas"}`);
  lines.push("", "Dados:", JSON.stringify(data, null, 2));
  return lines.join("\n");
}

function translateEmail(header: string, payload: Record<string, unknown>, data: Record<string, unknown>): string {
  const to = Array.isArray(data.to) ? data.to.filter((r): r is string => typeof r === "string") : [];
  const lines = [
    `[Resend] ${header}:`,
    `De: ${str(data.from) || "não informado"}`,
    `Para: ${to.join(", ") || "não informado"}`,
    `Assunto: ${str(data.subject) || "(sem assunto)"}`,
  ];
  const click = data.click && typeof data.click === "object"
    ? str((data.click as Record<string, unknown>).link)
    : "";
  if (click) lines.push(`Link: ${click}`);
  lines.push(
    `E-mail: ${str(data.email_id) || "?"}`,
    `Data e hora: ${str(payload.created_at) || str(data.created_at) || "não informadas"}`,
  );
  return lines.join("\n");
}
