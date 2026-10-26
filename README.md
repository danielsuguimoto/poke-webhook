# poke-webhook

Cloudflare Worker that receives webhook events from multiple tools, translates each into a human-readable message, and forwards it to the [Poke API](https://poke.com/docs/api) so your Poke agent can act on activity from any supported source.

## Supported sources

| Path         | Source    | Events |
|--------------|-----------|--------|
| `POST /agentmail` | [AgentMail](https://docs.agentmail.to/webhooks-overview) | `message.received`, `message.sent`, `message.delivered` |
| `POST /anakin` | [Anakin](https://anakin.io/docs/api-reference/webhooks) | `job.*`, `batch.*`, `wire.job.*`, `monitor.change`, `ai.search.*`, `webhook.test` — deliveries are deduplicated by event id (`changeId` for `monitor.change`) |
| `POST /circleback` | [Circleback](https://support.circleback.ai/en/articles/11014015-export-meeting-data-with-webhooks) | Meeting notes export |
| `POST /composio` | [Composio](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events) | `composio.trigger.message` (V3 envelope) — `metadata.trigger_slug` and `data` are forwarded; other project event types and legacy V1/V2 envelopes are ignored. Slack channel messages (e.g. `SLACK_CHANNEL_MESSAGE_RECEIVED`) forward only when the `SLACK_USER_ID` user is mentioned; direct messages always forward |
| `POST /goal-api` | [GOAL API](https://goal-api.com/documentation#webhooks) | `match.started`, `match.finished`, `goal.scored`, `score.changed`, `match.status_changed` — the full payload is forwarded as JSON |
| `POST /location-tracker` | [Location Tracker](https://github.com/danielsuguimoto/location-tracker) | Geofence `enter`, `exit`, `test` — activity context for location-based reminders; tests are explicitly labeled, not treated as real movement |
| `POST /parallel` | [Parallel](https://docs.parallel.ai/task-api/webhooks) | `task_run.status` — the run input is fetched via `GET /v1/tasks/runs/{run_id}/input` and the result via `GET /v1/tasks/runs/{run_id}/result` (completed runs) and forwarded |
| `POST /pluggy` | [Pluggy](https://docs.pluggy.ai/docs/webhooks) | `item/*`, `connector/status_updated`, `transactions/*`, `payment_intent/*`, `payment_request/updated`, `scheduled_payment/*`, `automatic_pix_payment/*`, `smart_transfer_*` |
| `POST /ramble` | [Ramble](https://goodloop.dev/ramble/docs) | Finished recordings — the transcript is forwarded; deliveries are deduplicated by `recording_id` (test payloads are always forwarded) |
| `POST /resend` | [Resend](https://resend.com/docs/webhooks/introduction) | `email.*`, `domain.*`, `contact.*`, `suppression.*`, `topic.*`, `inbox.*` — deliveries are deduplicated by event `type` + `created_at` + event data (retries redeliver an identical body) |
| `POST /tinyfish` | [TinyFish](https://docs.tinyfish.ai/webhooks) | `run.completed`, `run.failed`, `run.cancelled` — deliveries are deduplicated by `run_id` |
| `POST /todoist` | [Todoist](https://developer.todoist.com/api/v1/#tag/Webhooks) | `reminder:fired` — the task is fetched via the Todoist API and forwarded; Poke executes tasks with the `ai` label (marking them complete afterwards) and warns you about the rest |

Other event types are acknowledged with `202` and not forwarded (Todoist gets `200` instead — it retries any non-`200` delivery).

## How it works

1. A tool POSTs an event to its source-specific path on the Worker URL.
2. The source handler authenticates the request (signature, shared secret, or provider verification depending on the source; AgentMail and Resend sign webhooks via Svix — see the [AgentMail](https://docs.agentmail.to/webhook-verification) and [Resend](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests) verification docs).
3. The source handler translates the payload into a plain-text `message` string.
4. The message is forwarded to `POST $POKE_API_URL` with `Authorization: Bearer $POKE_API_KEY`.
5. The Worker returns `200` immediately; the Poke call runs in the background via `ctx.waitUntil`.

Generated message headers, labels, instructions, and fallback text are in Portuguese. Source content (such as email bodies, meeting notes, task descriptions, event identifiers, and the GOAL API JSON payload) stays in its original language.

## Configuration

### Non-secret vars (`wrangler.jsonc`)

| Var | Default | Description |
|-----|---------|-------------|
| `POKE_API_URL` | `https://poke.com/api/v1/inbound/api-message` | Poke inbound endpoint |
| `SLACK_USER_ID` | — | Optional Slack user ID (e.g. `U0123ABC456`); Composio Slack channel messages are forwarded only when this user is mentioned, and messages sent by this user are never forwarded. Unset = forward all |

### Secrets

Set via `wrangler secret put` (production) or `.dev.vars` (local dev, see `.dev.vars.example`):

| Secret | Description |
|--------|-------------|
| `POKE_API_KEY` | V2 Poke API key from [Kitchen](https://poke.com/kitchen) |
| `AGENTMAIL_WEBHOOK_SECRET` | AgentMail webhook signing secret (`whsec_...`), from `agentmail webhooks get` or the AgentMail console |
| `ANAKIN_WEBHOOK_SECRET` | Anakin webhook signing secret (`whsec_...`) — the endpoint secret or the default signing secret, from Account → Webhooks; verifies `X-Anakin-Signature` |
| `CIRCLEBACK_WEBHOOK_SECRET` | Circleback webhook signing secret, provided when configuring a webhook automation |
| `COMPOSIO_WEBHOOK_SECRET` | Composio webhook subscription secret, from the project's webhook settings; verifies `webhook-signature` (Standard Webhooks scheme) |
| `GOAL_API_WEBHOOK_SECRET` | GOAL API endpoint signing secret, shown once when creating a webhook endpoint in the [dashboard](https://goal-api.com/dashboard/webhooks); verifies `X-Goal-Signature` |
| `LOCATION_TRACKER_WEBHOOK_SECRET` | Required shared bearer token you choose; must match Location Tracker's endpoint `token` (`webhook_token` via MCP). Verifies `Authorization: Bearer <token>`; unset = fail closed |
| `PARALLEL_WEBHOOK_SECRET` | Parallel account webhook secret (`whsec_...`), from Settings → Webhooks on [platform.parallel.ai](https://platform.parallel.ai); verifies `webhook-signature` (Standard Webhooks) |
| `PARALLEL_API_KEY` | Parallel API key; used to fetch the run input and result when a `task_run.status` event arrives |
| `PLUGGY_WEBHOOK_SECRET` | Shared secret you choose; Pluggy sends it as the `x-webhook-secret` header |
| `RAMBLE_WEBHOOK_SECRET` | Ramble destination signing secret, from the destination's detail screen in Settings → Send via Webhook; verifies `X-Webhook-Signature` |
| `RESEND_WEBHOOK_SECRET` | Resend endpoint signing secret (`whsec_...`), from the webhook's details page or the create/retrieve API response; verifies `svix-signature` |
| `TODOIST_WEBHOOK_SECRET` | Todoist app `client_secret`, from the [App Management Console](https://app.todoist.com/app/settings/integrations/app-management-console); used to verify `X-Todoist-Hmac-SHA256` |
| `TODOIST_API_TOKEN` | Todoist API token (personal token from Settings → Integrations, or OAuth access token); used to fetch the task when a reminder fires |
| `TINYFISH_API_KEY` | TinyFish API key; each webhook's `run_id` is verified against `GET /v1/runs/{id}` before forwarding (TinyFish does not sign webhooks, so the worker fails closed without the key) |

```
wrangler secret put POKE_API_KEY
wrangler secret put AGENTMAIL_WEBHOOK_SECRET
wrangler secret put ANAKIN_WEBHOOK_SECRET
wrangler secret put CIRCLEBACK_WEBHOOK_SECRET
wrangler secret put COMPOSIO_WEBHOOK_SECRET
wrangler secret put GOAL_API_WEBHOOK_SECRET
wrangler secret put LOCATION_TRACKER_WEBHOOK_SECRET
wrangler secret put PARALLEL_WEBHOOK_SECRET
wrangler secret put PARALLEL_API_KEY
wrangler secret put PLUGGY_WEBHOOK_SECRET
wrangler secret put RAMBLE_WEBHOOK_SECRET
wrangler secret put RESEND_WEBHOOK_SECRET
wrangler secret put TODOIST_WEBHOOK_SECRET
wrangler secret put TODOIST_API_TOKEN
wrangler secret put TINYFISH_API_KEY
```

## Register a webhook

Example for AgentMail (point at the source-specific path). AgentMail signs requests automatically — no custom header needed:

```
agentmail webhooks create \
  --url https://<your-worker>.workers.dev/agentmail \
  --event-type message.received \
  --event-type message.sent \
  --event-type message.delivered
```

Retrieve the signing secret (`whsec_...`) and set it as `AGENTMAIL_WEBHOOK_SECRET`:

```
agentmail webhooks get --webhook-id <ep_xxx>
wrangler secret put AGENTMAIL_WEBHOOK_SECRET
```

Example for Pluggy. Pluggy does not sign requests — authentication is a shared-secret header, and custom headers can only be set via the API (not the dashboard). Create the webhook in the Pluggy dashboard pointing at `https://<your-worker>.workers.dev/pluggy`, then set the header via `PATCH /webhooks/{id}`:

```
curl -X PATCH https://api.pluggy.ai/webhooks/<webhook_id> \
  -H "X-API-KEY: <your_api_key>" \
  -H "Content-Type: application/json" \
  -d '{"headers": {"x-webhook-secret": "<your_secret>"}}'
```

Set the same value as `PLUGGY_WEBHOOK_SECRET`. For extra security you can also whitelist Pluggy's egress IP `52.67.145.81` at the network layer.

Example for Composio. Webhook subscriptions are configured once per project — in the [Composio dashboard](https://platform.composio.dev) (Project Settings → Webhooks) or via the API, set the payload URL to `https://<your-worker>.workers.dev/composio` and copy the generated webhook secret into `COMPOSIO_WEBHOOK_SECRET`. Only trigger instances that are enabled/active send events, so enable each trigger you want. Deliveries use the V3 envelope `{id, type: "composio.trigger.message", metadata: {trigger_slug, trigger_id, connected_account_id, ...}, data, timestamp}` and are signed per the [Standard Webhooks](https://www.standardwebhooks.com/) scheme: `webhook-signature: v1,<base64 HMAC-SHA256>` over `${webhook-id}.${webhook-timestamp}.${rawBody}`, with timestamps older than five minutes rejected. Other project events sent to the same URL (e.g. connection lifecycle events) and legacy V1/V2 envelopes are acknowledged with `202` and not forwarded. Slack channel-message triggers (`SLACK_CHANNEL_MESSAGE_RECEIVED` and other channel-message slugs) are forwarded only when the payload mentions the `SLACK_USER_ID` user — the check scans `data` recursively, covering both the `<@U...>` mention form in text and `user`/`user_id` fields in rich_text blocks; unmentioned channel messages are acknowledged with `202` so Composio does not retry. Direct messages (`SLACK_DIRECT_MESSAGE_RECEIVED`) always forward, and when `SLACK_USER_ID` is not configured everything forwards. Independently of mentions, Slack messages sent by the `SLACK_USER_ID` user (sender `user`/`user_id`, including nested `event`/`message` envelopes) are dropped with `202` and never forwarded. Deliveries are deduplicated by event `id`, and a Poke forward failure returns `503` so Composio redelivers.

Example for GOAL API. Create the endpoint in the [webhooks dashboard](https://goal-api.com/dashboard/webhooks) pointing at `https://<your-worker>.workers.dev/goal-api`, select the events and (optionally) `leagueIds` to filter competitions. The signing secret is shown once at creation — copy it into `GOAL_API_WEBHOOK_SECRET`. Deliveries are signed via `X-Goal-Signature: t=<ts>,v1=<hmac-sha256 hex>` over `<ts>.<raw body>`, and signatures older than five minutes are rejected.

### Location Tracker geofence notifications

1. Generate a strong random shared token (for example, `openssl rand -hex 32`), and store it as the Worker's `LOCATION_TRACKER_WEBHOOK_SECRET` using `wrangler secret put LOCATION_TRACKER_WEBHOOK_SECRET`. Set `POKE_API_KEY` separately; the inbound token is **not** the Poke API key. For local dev, copy `.dev.vars.example` to `.dev.vars` and replace the placeholders. Never commit real tokens. Preview secrets must be configured separately (see [Cloudflare Workers Builds](#cloudflare-workers-builds)).
2. In Location Tracker's admin UI (`/admin/webhooks`), add an endpoint with URL `https://<your-worker>.workers.dev/location-tracker` and set **Bearer token** to the same shared token. Attach geofences to this endpoint. Alternatively, use Location Tracker's MCP `register_geofence` with that URL as `webhook_url` and the token as `webhook_token`, or reuse an endpoint via `webhook_id`.
3. Send a test using the geofence's admin test action or MCP `test_geofence_notification`. It should return HTTP `200` from this Worker, and Poke should receive a clearly labeled test notice. A test is not a real arrival/departure and should not trigger movement-based reminders.

Location Tracker POSTs JSON with `Content-Type: application/json` and `Authorization: Bearer <webhook.token>`:

```json
{
  "event": "enter",
  "geofence": {"id": "fence-1", "name": "home", "lat": -23.5, "lon": -46.6, "radius_m": 200},
  "location": {"lat": -23.501, "lon": -46.601, "acc": 5, "tst": 1700000000, "device": "JJ"},
  "message": "Jun arrived at \"home\"",
  "timestamp": 1700000000
}
```

- `event` is `enter`, `exit`, or `test`. All three are forwarded. Unknown event types receive `202` and are not forwarded.
- `geofence` contains the nonempty string `id` and `name`, numeric `lat`/`lon` coordinates and positive numeric `radius_m` (meters).
- `location` is either `null` (for example, a test before any location exists) or an object with numeric `lat`/`lon`, `acc` (nonnegative meters or `null`), `tst` (Unix seconds), and `device` (string or `null`). Null location is accepted for every event. Latitude/longitude must be within ±90/±180 degrees.
- `message` is a string preserved in its original language. `timestamp` is the delivery/event creation time in Unix seconds; `location.tst` is the device fix time, which may be older. Both must be nonnegative integers representable as dates; rendered timestamps use ISO 8601 UTC, not milliseconds or local time. Additional fields are ignored.

The Poke message has Portuguese labels for arrival/departure/test, geofence name/ID, center/radius, event time, original message, and available location/accuracy/device/fix time. Enter/exit provide activity context for relevant location-based reminders; the Worker does not create reminders or query a task list. Test messages explicitly say no real entry or exit occurred. No person/device identifier is hardcoded in the handler.

Although Location Tracker allows tokenless endpoints, **this receiver requires a bearer token**: missing Worker secret returns `500`; missing, malformed, or mismatched authorization returns `401` before JSON parsing; malformed JSON or known-event payloads return `400`. Accepted responses are `200` with `{"status":"accepted","event_type":"enter","event_id":"fence-1"}` (`event_id` is the geofence ID, not a unique delivery ID).

Forwarding uses the existing `forwardToPoke` helper and `ctx.waitUntil`: acceptance does not guarantee downstream delivery. Poke failures are logged; there is no retry queue. Location Tracker currently attempts delivery once with a five-second timeout and logs the response in its delivery log. No deduplication or timestamp freshness/replay window is imposed here: upstream supplies no unique delivery ID, timestamps have second precision, and tests can refer to older location fixes. Repeated POSTs are forwarded again.

Example for TinyFish. Pass `webhook_url` when creating a run (must be HTTPS):

```
curl -X POST https://agent.tinyfish.ai/v1/automation/run-async \
  -H "X-API-Key: $TINYFISH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "goal": "Extract the page title",
       "webhook_url": "https://<your-worker>.workers.dev/tinyfish"}'
```

TinyFish does not sign webhook deliveries, so the worker verifies each `run_id` against `GET /v1/runs/{id}` before forwarding — `TINYFISH_API_KEY` is required (the endpoint fails closed without it), unknown runs get `401`, status mismatches get `409`, and verification errors get `503` so TinyFish retries. Duplicate deliveries of the same `run_id` are deduplicated and acknowledged with `202`.

Example for Parallel. Pass the `webhook` parameter when creating a task run; deliveries are signed following the [Standard Webhooks spec](https://docs.parallel.ai/resources/webhook-setup) (`webhook-id`, `webhook-timestamp`, `webhook-signature` headers):

```
curl -X POST https://api.parallel.ai/v1/tasks/runs \
  -H "x-api-key: $PARALLEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "France (2023)", "processor": "core", "webhook": {"url": "https://<your-worker>.workers.dev/parallel", "event_types": ["task_run.status"]}}'
```

On completion the worker fetches the run input (and result, for `completed` runs) with `PARALLEL_API_KEY` and forwards both to Poke. Non-terminal statuses are acknowledged with `202` and not forwarded.

Example for Ramble. In the Ramble app, go to Settings → Send via Webhook, tap Add a destination, and paste `https://<your-worker>.workers.dev/ramble`. Copy the destination's signing secret from its detail screen into `RAMBLE_WEBHOOK_SECRET` — deliveries are signed via `X-Webhook-Signature: sha256=<hmac-sha256 hex>` over the raw body. Use Send Test Webhook in the app to verify the setup; test payloads (`test: true`, `recording_id` prefixed `test-`) are always forwarded so you can confirm the round trip. Failed deliveries are retried by Ramble up to 3 times, so duplicates of the same `recording_id` are deduplicated and acknowledged with `202`.

Example for Resend. In the [Resend dashboard](https://resend.com/webhooks) (or via `POST /webhooks` on the API), create a webhook pointing at `https://<your-worker>.workers.dev/resend` and select the events to receive. Copy the signing secret (`whsec_...`) from the webhook's details page into `RESEND_WEBHOOK_SECRET` — deliveries are signed via `svix-id`, `svix-timestamp` and `svix-signature` headers (Svix / Standard Webhooks scheme). `email.*` events are forwarded with sender, recipients, subject and timestamp; `domain.*`, `contact.*`, `suppression.*`, `topic.*` and `inbox.*` events forward a summary plus the event data. Retried deliveries share the same `svix-id` and body, so duplicates are deduplicated by `type` + `created_at` + event data and acknowledged with `202`; a Poke forward failure returns `503` so Resend redelivers.

Example for Todoist. In the App Management Console, set the webhook callback URL to `https://<your-worker>.workers.dev/todoist` and subscribe to `reminder:fired`. Webhooks only fire for users who completed your app's OAuth flow — for personal use, run the OAuth flow manually once with your own account (see the [Todoist docs](https://developer.todoist.com/api/v1/#tag/Webhooks)). When a reminder fires, the worker fetches the task from the Todoist API using `TODOIST_API_TOKEN` and forwards it to Poke; tasks with the `ai` label are executed by Poke (which is instructed to mark them complete in Todoist afterwards), while the rest only trigger a warning to you.

## Add a new source

1. Create `src/sources/<name>.ts` exporting a `SourceHandler` (`handle(payload, env, ctx)` → `Response`, optional `authorize(rawBody, request, env)` → `Response | null`).
2. Register it in `src/index.ts` under a new path in `ROUTES`.

## Cloudflare Workers Builds

In the Worker's **Settings > Builds**, use these commands in the **Production** and **Previews Base** configurations:

| Setting | Command |
|---------|---------|
| Deploy command (Production) | `npm run deploy` |
| Preview command (Previews Base) | `npm run deploy:preview` |

This project uses [Worker Previews](https://developers.cloudflare.com/workers/previews/get-started/), which requires Wrangler 4.135.0 or later. `npm run deploy:preview` runs the supported `wrangler preview` command to create or update the current branch's Preview. Wrangler 3 has an older, deprecated command with the same name; Cloudflare uses the project's installed version, so updating only the dashboard command does not fix that version mismatch. `wrangler dev` starts a development server; `wrangler versions upload` belongs to the separate [Version URLs workflow](https://developers.cloudflare.com/workers/previews/compare-workflows/).

Preview settings are defined in the `previews` block of `wrangler.jsonc`. Previews do not inherit production variables or secrets. Add any required Preview secrets to **Previews Base** or to the individual Preview; see the [Preview configuration docs](https://developers.cloudflare.com/workers/previews/configuration/).

Build commands are saved separately in Cloudflare. Save the Preview command, then push a commit to the PR branch to trigger a new build. Either `npm run deploy:preview` or `npx wrangler preview` uses the supported command once the project dependency is updated.

## Develop

Use Node.js 22 or later, as required by Wrangler 4.

```
npm install
npm run dev        # local dev via wrangler
npm run typecheck
npm test          # message translation and source-data preservation
npm run deploy     # publish to Cloudflare
npm run deploy:preview # deploy the current branch's Worker Preview
```

## Responses

| Status | Meaning |
|--------|---------|
| `200` | Event accepted and queued for Poke |
| `202` | Event received but ignored (unsupported type or empty translation) |
| `400` | Invalid JSON body |
| `401` | Missing/invalid Svix signature headers |
| `404` | Unknown source path |
| `405` | Non-POST method |
| `500` | A webhook secret or API token is not configured |
