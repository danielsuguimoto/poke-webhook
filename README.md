# poke-webhook

Cloudflare Worker that receives webhook events from multiple tools, translates each into a human-readable message, and forwards it to the [Poke API](https://poke.com/docs/api) so your Poke agent can act on activity from any supported source.

## Supported sources

| Path         | Source    | Events |
|--------------|-----------|--------|
| `POST /agentmail` | [AgentMail](https://docs.agentmail.to/webhooks-overview) | `message.received`, `message.sent`, `message.delivered` |
| `POST /circleback` | [Circleback](https://support.circleback.ai/en/articles/11014015-export-meeting-data-with-webhooks) | Meeting notes export |

Other event types are acknowledged with `202` and not forwarded.

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

```
wrangler secret put POKE_API_KEY
wrangler secret put AGENTMAIL_WEBHOOK_SECRET
wrangler secret put CIRCLEBACK_WEBHOOK_SECRET
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
