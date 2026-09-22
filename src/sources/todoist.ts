import type { Env, SourceHandler } from "../index";
import { forwardToPoke, accepted } from "../poke";
import { json } from "../utils";

const AI_LABEL = "ai";
const TODOIST_API_URL = "https://api.todoist.com/api/v1";

export const todoist: SourceHandler = {
  async authorize(rawBody, request, env): Promise<Response | null> {
    const secret = env.TODOIST_WEBHOOK_SECRET;
    if (!secret) return json(500, { error: "missing_webhook_secret" });

    const signature = request.headers.get("x-todoist-hmac-sha256");
    if (!signature) return json(401, { error: "missing_signature_header" });

    const expected = await hmacBase64(secret, rawBody);
    if (!constantTimeEqual(expected, signature)) {
      return json(401, { error: "invalid_signature" });
    }
    return null;
  },

  async handle(payload, env, ctx): Promise<Response> {
    const eventName = typeof payload.event_name === "string" ? payload.event_name : "";
    const reminder = (payload.event_data ?? {}) as TodoistReminder;
    const reminderId = typeof reminder.id === "string" ? reminder.id : "";

    if (eventName !== "reminder:fired") return todoistIgnored(eventName || "unknown", reminderId);

    const taskId = typeof reminder.item_id === "string" ? reminder.item_id : "";
    if (!taskId) return todoistIgnored(eventName, reminderId);

    if (!env.TODOIST_API_TOKEN) return json(500, { error: "missing_api_token" });
    const task = await fetchTask(taskId, env);
    if (!task) return todoistIgnored(eventName, reminderId);

    ctx.waitUntil(forwardToPoke(translate(reminder, task), env));
    return accepted(eventName, reminderId);
  },
};

// Todoist retries deliveries that don't return HTTP 200, so ignored events
// must still answer 200 instead of the shared 202 helper.
function todoistIgnored(eventName: string, reminderId: string): Response {
  return json(200, { status: "ignored", event_name: eventName, reminder_id: reminderId });
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface TodoistReminder {
  id?: string;
  item_id?: string;
  type?: string;
  due?: { string?: string; date?: string } | null;
}

interface TodoistTask {
  id?: string;
  content?: string;
  description?: string;
  labels?: unknown;
  priority?: number;
  url?: string;
  due?: { string?: string; date?: string } | null;
}

async function fetchTask(taskId: string, env: Env): Promise<TodoistTask | null> {
  const res = await fetch(`${TODOIST_API_URL}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
  });
  if (!res.ok) {
    console.error(`Todoist API error ${res.status} fetching task ${taskId}`);
    return null;
  }
  return (await res.json()) as TodoistTask;
}

function hasAiLabel(labels: unknown): boolean {
  return (
    Array.isArray(labels) &&
    labels.some((l) => typeof l === "string" && l.toLowerCase() === AI_LABEL)
  );
}

function translate(reminder: TodoistReminder, task: TodoistTask): string {
  const labels = Array.isArray(task.labels) ? task.labels.join(", ") : "";
  const firedAt = reminder.due?.string ?? reminder.due?.date;
  const due = task.due?.string ?? task.due?.date;
  const header = hasAiLabel(task.labels)
    ? `[Todoist] Reminder fired for a task tagged with the "${AI_LABEL}" label — execute this task:`
    : "[Todoist] Reminder fired — warn the user about this task:";
  return [
    header,
    `Task: ${task.content ?? "(untitled)"}`,
    ...(task.description ? [`Description: ${task.description}`] : []),
    ...(due ? [`Due: ${due}`] : []),
    `Priority: ${task.priority ?? "unknown"}`,
    ...(labels ? [`Labels: ${labels}`] : []),
    ...(task.url ? [`Link: ${task.url}`] : []),
    ...(firedAt ? [`Reminder: ${firedAt}`] : []),
  ].join("\n");
}
