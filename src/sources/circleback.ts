import type { SourceHandler } from "../index";
import { forwardToPoke, accepted, ignored } from "../poke";
import { json } from "../utils";

export const circleback: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.CIRCLEBACK_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const signature = request.headers.get("x-signature");
    if (!signature) return json(401, { error: "missing_signature_header" });

    const expected = await hmacHex(secret, rawBody);
    if (!constantTimeEqualHex(expected, signature)) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, ctx): Promise<Response> {
    const meetingId = typeof payload.id === "string" ? payload.id : "";
    const message = translate(payload);
    if (!message) return ignored("meeting", meetingId);

    ctx.waitUntil(forwardToPoke(message, env));
    return accepted("meeting", meetingId);
  },
};

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Attendee {
  name?: string | null;
  email?: string | null;
}

interface ActionItem {
  id?: number;
  title?: string;
  description?: string;
  assignee?: { name?: string | null; email?: string | null } | null;
  status?: string;
}

interface TranscriptSegment {
  speaker?: string;
  text?: string;
  timestamp?: number;
}

interface CirclebackPayload {
  id?: string;
  name?: string;
  createdAt?: string;
  duration?: number;
  url?: string | null;
  recordingUrl?: string | null;
  tags?: string[];
  icalUid?: string | null;
  attendees?: Attendee[];
  notes?: string;
  actionItems?: ActionItem[];
  transcript?: TranscriptSegment[];
  insights?: Record<string, unknown>;
}

function translate(payload: Record<string, unknown>): string | null {
  const m = payload as CirclebackPayload;
  if (!m || typeof m !== "object" || !m.id) return null;

  const durationMin =
    typeof m.duration === "number" ? `${(m.duration / 60).toFixed(1)}m` : "unknown";
  const attendees = (m.attendees ?? [])
    .map((a) => a.name || a.email || "unknown")
    .join(", ");
  const tags = (m.tags ?? []).join(", ");
  const link = `https://circleback.ai/meetings/${m.id}`;

  const lines: string[] = [
    `[Circleback] Meeting notes for "${m.name ?? "untitled"}":`,
    `Link: ${link}`,
    `Time: ${m.createdAt ?? "unknown"}`,
    `Duration: ${durationMin}`,
    ...(attendees ? [`Attendees: ${attendees}`] : []),
    ...(tags ? [`Tags: ${tags}`] : []),
    ...(m.url ? [`Meeting URL: ${m.url}`] : []),
  ];

  const actionItems = m.actionItems ?? [];
  if (actionItems.length) {
    lines.push("", "Action items:");
    for (const item of actionItems) {
      const assignee = item.assignee
        ? item.assignee.name || item.assignee.email || "unknown"
        : "unassigned";
      const status = item.status === "DONE" ? "[done]" : "[pending]";
      lines.push(`- ${status} ${item.title ?? "(untitled)"} (assigned to ${assignee})`);
    }
  }

  if (m.notes) {
    lines.push("", "Notes:", m.notes);
  }

  const insights = m.insights;
  if (insights && typeof insights === "object" && Object.keys(insights).length) {
    lines.push("", "Insights:");
    for (const [name, entries] of Object.entries(insights)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as { insight?: unknown; speaker?: string | null };
        const insightStr =
          typeof e.insight === "string"
            ? e.insight
            : e.insight && typeof e.insight === "object"
              ? JSON.stringify(e.insight)
              : String(e.insight ?? "");
        const speaker = e.speaker ? ` (${e.speaker})` : "";
        lines.push(`- [${name}]${speaker} ${insightStr}`);
      }
    }
  }

  const transcript = m.transcript ?? [];
  if (transcript.length) {
    lines.push("", `Transcript (${transcript.length} segments):`);
    for (const seg of transcript) {
      lines.push(`${seg.speaker ?? "unknown"}: ${seg.text ?? ""}`);
    }
  }

  return lines.join("\n");
}
