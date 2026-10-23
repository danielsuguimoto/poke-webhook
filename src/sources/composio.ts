import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

const TIMESTAMP_TOLERANCE_SECONDS = 300;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10_000;

// Best-effort deduplication within a worker isolate, keyed by the event's
// envelope `id`, so retried deliveries are acknowledged without re-forwarding.
const seenEvents = new Map<string, number>();
// event id -> in-flight forward, so concurrent duplicate deliveries
// share the first attempt's outcome instead of being acknowledged early.
const inFlight = new Map<string, Promise<boolean>>();

function markSeen(eventId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return false;
  if (seenEvents.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenEvents.keys().next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  seenEvents.set(eventId, now);
  return true;
}

// Composio signs deliveries per the Standard Webhooks scheme:
// base64(HMAC-SHA256(secret, `${webhook-id}.${webhook-timestamp}.${rawBody}`)),
// sent in `webhook-signature` as `v1,<sig>` entries (whitespace/comma-separated).
export const composio: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.COMPOSIO_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const messageId = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");
    const signature = request.headers.get("webhook-signature");
    if (!messageId || !timestamp || !signature) {
      return json(401, { error: "missing_signature_headers" });
    }

    const ts = /^\d+$/.test(timestamp) ? Number.parseInt(timestamp, 10) : NaN;
    if (Number.isNaN(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
      return json(401, { error: "stale_timestamp" });
    }

    const expected = await hmacBase64(secret, `${messageId}.${timestamp}.${rawBody}`);
    const received = [...signature.matchAll(/v1,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
    if (!received.some((sig) => constantTimeEqual(sig, expected))) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, _ctx): Promise<Response> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "invalid_payload" });
    }
    const eventType = typeof payload.type === "string" ? payload.type : "";
    const eventId = typeof payload.id === "string" ? payload.id : "";

    // Only V3 trigger messages are supported; other project events delivered
    // to the same URL (connection expiry, legacy V1/V2 envelopes) are ignored.
    if (eventType !== "composio.trigger.message") {
      return ignored(eventType || "unknown", eventId);
    }

    const metadata = payload.metadata && typeof payload.metadata === "object"
      ? (payload.metadata as Record<string, unknown>)
      : {};
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};
    const dedupId = eventId || str(metadata.log_id);

    // Messages sent by the configured user (outbound posts/DMs) are never
    // forwarded; channel messages from others are only relevant when that
    // user is mentioned; direct messages always forward, as does everything
    // when SLACK_USER_ID is not configured.
    const triggerSlug = str(metadata.trigger_slug) || str(data.trigger_slug);
    const slug = triggerSlug.toUpperCase();
    if (
      slug.includes("SLACK")
      && (slug.includes("MESSAGE") || /(^|_)DM(_RECEIVED)?$/.test(slug) || isSlackMessagePayload(data))
      && env.SLACK_USER_ID
      && env.SLACK_USER_ID === senderUserId(data)
    ) {
      return ignored(eventType, dedupId);
    }
    if (
      env.SLACK_USER_ID
      && isChannelMessageTrigger(triggerSlug, data)
      && !containsMention(data, env.SLACK_USER_ID)
    ) {
      return ignored(eventType, dedupId);
    }

    if (dedupId) {
      const pending = inFlight.get(dedupId);
      if (pending) {
        const delivered = await pending;
        return delivered
          ? ignored(eventType, dedupId)
          : json(503, { error: "poke_forward_failed" });
      }
      if (!markSeen(dedupId)) return ignored(eventType, dedupId);
    }

    const forward = forwardToPoke(translate(payload, metadata, eventId), env);
    if (dedupId) inFlight.set(dedupId, forward);
    const delivered = await forward;
    if (dedupId) {
      inFlight.delete(dedupId);
      if (!delivered) seenEvents.delete(dedupId);
    }
    if (!delivered) return json(503, { error: "poke_forward_failed" });
    return accepted(eventType, dedupId);
  },
};

async function hmacBase64(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "";
}

// True when the event is a Slack message: `type: "message"` on the payload or
// on a nested `event`/`message` envelope. Reactions and other event types that
// happen to carry channel/user fields are not messages.
function isSlackMessagePayload(data: Record<string, unknown>): boolean {
  for (const container of [data, data.event, data.message]) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    if (str((container as Record<string, unknown>).type) === "message") return true;
  }
  return false;
}

// The sending user's ID on a Slack message payload: `user`/`user_id` on the
// payload or on a nested `event`/`message` envelope (e.g. message_changed
// carries the sender at `data.event.message.user`).
function senderUserId(data: Record<string, unknown>): string {
  const queue: unknown[] = [data];
  for (const container of queue) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const record = container as Record<string, unknown>;
    const id = str(record.user) || str(record.user_id);
    if (id) return id;
    if (container !== data) continue;
    queue.push(record.event, record.message);
    if (record.event && typeof record.event === "object" && !Array.isArray(record.event)) {
      queue.push((record.event as Record<string, unknown>).message);
    }
  }
  return "";
}

// Channel-message triggers (e.g. SLACK_CHANNEL_MESSAGE_RECEIVED) are gated on
// a mention; direct messages (e.g. SLACK_DIRECT_MESSAGE_RECEIVED) are not.
// Only Slack events are gated: non-Slack triggers that happen to name a
// channel or carry `channel_type` are forwarded as before.
function isChannelMessageTrigger(triggerSlug: string, data: Record<string, unknown>): boolean {
  const slug = triggerSlug.toUpperCase();
  if (slug.includes("DIRECT_MESSAGE") || /(^|_)DM(_|$)/.test(slug)) return false;
  const channelType = str(data.channel_type);
  const channelMessage =
    (slug.includes("CHANNEL") && slug.includes("MESSAGE"))
    || channelType === "channel" || channelType === "group";
  if (!channelMessage) return false;
  return slug.includes("SLACK") || (!slug && !!channelType);
}

// Matches the `<@U...>` mention form in message text as well as `user`/`user_id`
// fields in rich_text blocks, plus the `<!here>`/`<!channel>` broadcast mentions
// (text form and `broadcast` rich_text elements). The top-level `user`/`user_id`
// sender fields are excluded so messages the configured user posts are not
// treated as mentions.
function containsMention(data: Record<string, unknown>, userId: string): boolean {
  const { user: _user, user_id: _userId, ...rest } = data;
  return containsUserId(rest, userId);
}

// mrkdwn literal contexts where mention-looking text is not a real mention:
// inline `code` spans and fenced ``` code blocks ```.
const MRKDWN_LITERAL = /```[\s\S]*?```|`[^`\n]*`/g;
// `<!here>` and `<!channel>` including the labeled `<!here|@here>` form; the
// closing `>` is required so an unfinished `<!here|label` is not a mention.
const BROADCAST_MENTION = /<!(here|channel)(\|[^>]*)?>/;
const BROADCAST_RANGES = new Set(["here", "channel"]);
// rich_text block elements whose contents are preformatted (literal) text;
// mention-like tokens inside them are code samples, not mentions.
const LITERAL_BLOCK_TYPES = new Set(["rich_text_preformatted"]);

function containsUserId(value: unknown, userId: string): boolean {
  if (typeof value === "string") {
    if (value === userId
      || value.includes(`<@${userId}>`)
      || value.includes(`<@${userId}|`)) {
      return true;
    }
    return BROADCAST_MENTION.test(value.replace(MRKDWN_LITERAL, " "));
  }
  if (Array.isArray(value)) return value.some((v) => containsUserId(v, userId));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && LITERAL_BLOCK_TYPES.has(record.type)) {
      return false;
    }
    if (record.type === "broadcast" && BROADCAST_RANGES.has(record.range as string)) {
      return true;
    }
    for (const nested of Object.values(value)) {
      if (containsUserId(nested, userId)) return true;
    }
  }
  return false;
}

function translate(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  eventId: string,
): string {
  const lines: string[] = [
    `[Composio] Novo evento do gatilho ${str(metadata.trigger_slug) || "desconhecido"}:`,
  ];
  if (eventId) lines.push(`ID do evento: ${eventId}`);
  if (str(metadata.trigger_id)) lines.push(`Gatilho: ${str(metadata.trigger_id)}`);
  if (str(metadata.connected_account_id)) {
    lines.push(`Conta conectada: ${str(metadata.connected_account_id)}`);
  }
  lines.push(`Data e hora: ${str(payload.timestamp) || "não informadas"}`);
  lines.push("", "Dados:", JSON.stringify(payload.data ?? {}, null, 2));
  return lines.join("\n");
}
