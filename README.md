# poke-webhook

Cloudflare Worker that receives webhook events from multiple tools, translates each into a human-readable message, and forwards it to the [Poke API](https://poke.com/docs/api) so your Poke agent can act on activity from any supported source.

## Supported sources

| Path         | Source    | Events |
|--------------|-----------|--------|
| `POST /agentmail` | [AgentMail](https://docs.agentmail.to/webhooks-overview) | `message.received`, `message.sent`, `message.delivered` |
| `POST /circleback` | [Circleback](https://support.circleback.ai/en/articles/11014015-export-meeting-data-with-webhooks) | Meeting notes export |
| `POST /goal-api` | [GOAL API](https://goal-api.com/documentation#webhooks) | `match.started`, `match.finished`, `goal.scored`, `score.changed`, `match.status_changed` — the full payload is forwarded as JSON |
| `POST /pluggy` | [Pluggy](https://docs.pluggy.ai/docs/webhooks) | `item/*`, `connector/status_updated`, `transactions/*`, `payment_intent/*`, `payment_request/updated`, `scheduled_payment/*`, `automatic_pix_payment/*`, `smart_transfer_*` |
| `POST /todoist` | [Todoist](https://developer.todoist.com/api/v1/#tag/Webhooks) | `reminder:fired` — the task is fetched via the Todoist API and forwarded; Poke executes tasks with the `ai` label and warns you about the rest |

Other event types are acknowledged with `202` and not forwarded (Todoist gets `200` instead — it retries any non-`200` delivery).

## How it works

1. A tool POSTs an event to its source-specific path on the Worker URL.
2. The source handler verifies the request signature (AgentMail signs webhooks via Svix; see [verification docs](https://docs.agentmail.to/webhook-verification)).
3. The source handler translates the payload into a plain-text `message` string.
4. The message is forwarded to `POST $POKE_API_URL` with `Authorization: Bearer $POKE_API_KEY`.
5. The Worker returns `200` immediately; the Poke call runs in the background via `ctx.waitUntil`.

## Configuration

### Non-secret vars (`wrangler.jsonc`)

| Var | Default | Description |
|-----|---------|-------------|
| `POKE_API_URL` | `https://poke.com/api/v1/inbound/api-message` | Poke inbound endpoint |

### Secrets

Set via `wrangler secret put` (production) or `.dev.vars` (local dev, see `.dev.vars.example`):

| Secret | Description |
|--------|-------------|
| `POKE_API_KEY` | V2 Poke API key from [Kitchen](https://poke.com/kitchen) |
| `AGENTMAIL_WEBHOOK_SECRET` | AgentMail webhook signing secret (`whsec_...`), from `agentmail webhooks get` or the AgentMail console |
| `CIRCLEBACK_WEBHOOK_SECRET` | Circleback webhook signing secret, provided when configuring a webhook automation |
| `GOAL_API_WEBHOOK_SECRET` | GOAL API endpoint signing secret, shown once when creating a webhook endpoint in the [dashboard](https://goal-api.com/dashboard/webhooks); verifies `X-Goal-Signature` |
| `PLUGGY_WEBHOOK_SECRET` | Shared secret you choose; Pluggy sends it as the `x-webhook-secret` header |
| `TODOIST_WEBHOOK_SECRET` | Todoist app `client_secret`, from the [App Management Console](https://app.todoist.com/app/settings/integrations/app-management-console); used to verify `X-Todoist-Hmac-SHA256` |
| `TODOIST_API_TOKEN` | Todoist API token (personal token from Settings → Integrations, or OAuth access token); used to fetch the task when a reminder fires |

```
wrangler secret put POKE_API_KEY
wrangler secret put AGENTMAIL_WEBHOOK_SECRET
wrangler secret put CIRCLEBACK_WEBHOOK_SECRET
wrangler secret put GOAL_API_WEBHOOK_SECRET
wrangler secret put PLUGGY_WEBHOOK_SECRET
wrangler secret put TODOIST_WEBHOOK_SECRET
wrangler secret put TODOIST_API_TOKEN
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

Example for GOAL API. Create the endpoint in the [webhooks dashboard](https://goal-api.com/dashboard/webhooks) pointing at `https://<your-worker>.workers.dev/goal-api`, select the events and (optionally) `leagueIds` to filter competitions. The signing secret is shown once at creation — copy it into `GOAL_API_WEBHOOK_SECRET`. Deliveries are signed via `X-Goal-Signature: t=<ts>,v1=<hmac-sha256 hex>` over `<ts>.<raw body>`, and signatures older than five minutes are rejected.

Example for Todoist. In the App Management Console, set the webhook callback URL to `https://<your-worker>.workers.dev/todoist` and subscribe to `reminder:fired`. Webhooks only fire for users who completed your app's OAuth flow — for personal use, run the OAuth flow manually once with your own account (see the [Todoist docs](https://developer.todoist.com/api/v1/#tag/Webhooks)). When a reminder fires, the worker fetches the task from the Todoist API using `TODOIST_API_TOKEN` and forwards it to Poke; tasks with the `ai` label are executed by Poke, while the rest only trigger a warning to you.

## Add a new source

1. Create `src/sources/<name>.ts` exporting a `SourceHandler` (`handle(payload, env, ctx)` → `Response`, optional `authorize(rawBody, request, env)` → `Response | null`).
2. Register it in `src/index.ts` under a new path in `ROUTES`.

## Develop

```
npm install
npm run dev        # local dev via wrangler
npm run typecheck
npm run deploy     # publish to Cloudflare
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
| `500` | `AGENTMAIL_WEBHOOK_SECRET` not configured |
