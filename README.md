# poke-webhook

Cloudflare Worker that receives webhook events from multiple tools, translates each into a human-readable message, and forwards it to the [Poke API](https://poke.com/docs/api) so your Poke agent can act on activity from any supported source.

## Supported sources

| Path         | Source    | Events |
|--------------|-----------|--------|
| `POST /agentmail` | [AgentMail](https://docs.agentmail.to/webhooks-overview) | `message.received`, `message.sent`, `message.delivered` |

Other event types are acknowledged with `202` and not forwarded.

## How it works

1. A tool POSTs an event to its source-specific path on the Worker URL.
2. The Worker validates a shared-secret delivery header.
3. The source handler translates the payload into a plain-text `message` string.
4. The message is forwarded to `POST $POKE_API_URL` with `Authorization: Bearer $POKE_API_KEY`.
5. The Worker returns `200` immediately; the Poke call runs in the background via `ctx.waitUntil`.

## Configuration

### Non-secret vars (`wrangler.jsonc`)

| Var | Default | Description |
|-----|---------|-------------|
| `POKE_API_URL` | `https://poke.com/api/v1/inbound/api-message` | Poke inbound endpoint |
| `WEBHOOK_SECRET_HEADER` | `X-Webhook-Secret` | Header name sources send the shared secret on |

### Secrets

Set via `wrangler secret put` (production) or `.dev.vars` (local dev, see `.dev.vars.example`):

| Secret | Description |
|--------|-------------|
| `POKE_API_KEY` | V2 Poke API key from [Kitchen](https://poke.com/kitchen) |
| `WEBHOOK_SECRET` | Shared secret configured as a custom delivery header on each source webhook |

```
wrangler secret put POKE_API_KEY
wrangler secret put WEBHOOK_SECRET
```

## Register a webhook

Example for AgentMail (point at the source-specific path):

```
agentmail webhooks create \
  --url https://<your-worker>.workers.dev/agentmail \
  --event-type message.received \
  --event-type message.sent \
  --event-type message.delivered \
  --header "X-Webhook-Secret: $WEBHOOK_SECRET"
```

## Add a new source

1. Create `src/sources/<name>.ts` exporting a `SourceHandler` (`handle(payload, env, ctx)` → `Response`).
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
| `401` | Missing/invalid shared-secret header |
| `404` | Unknown source path |
| `405` | Non-POST method |
| `500` | `WEBHOOK_SECRET` not configured |
