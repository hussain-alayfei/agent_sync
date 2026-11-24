# 8. Real-time relay: getting live events into your own systems

Zaid's audio and video reach viewers through LiveKit. Everything else that happens in the studio (a story goes on
air, finishes, is skipped, breaking news arrives, the show ends) is an **event**. This guide is about moving those
events, in real time, into your own systems: your CMS, your control room, your website's "live now" badge,
another agent.

There are three ways to receive them. Pick one, or combine them.

```
                         ┌──► (A) Pull: GET /api/v1/events (Server-Sent Events)  ──► your backend
 Zaid backend ── events ─┼──► (B) Push: webhook POST, signed                        ──► your endpoint ──► anything
                         └──► (C) Viewers: LiveKit data messages (topic "zaid")     ──► every viewer's browser
```

| | Pull (SSE) | Push (webhook) | LiveKit data |
|---|---|---|---|
| Who connects | Your backend opens a long-lived connection | Zaid calls your URL | Already inside the broadcast |
| Best for | A control room or service that is always running | Serverless functions, queues, databases, fan-out | Captions and headlines on the viewer page |
| Delivery | While connected (reconnect and read `/log` to catch up) | One POST per event, 5 s timeout, no retry | With the broadcast, to everyone watching |
| Auth | `x-api-key` | HMAC signature you verify | Viewer token |

## A. Pull: Server-Sent Events

`GET /api/v1/events` with the `x-api-key` header. Two event types: `rundown` (the whole rundown and studio state,
on every change) and `log` (one event). Example code is in [04-connect-your-backend.md](04-connect-your-backend.md).
If the connection drops, reconnect and call `GET /api/v1/log?limit=100` to fill the gap.

## B. Push: the event webhook

Set it on the console → **Website & API** → **Event webhook**: a URL and a signing secret. Every event is POSTed as:

```http
POST /your/endpoint
content-type: application/json
x-zaid-event: on_air
x-zaid-signature: sha256=5f0c…   (HMAC-SHA256 of the raw body with your signing secret)

{
  "event": "on_air",
  "at": "2026-11-24T14:22:16.410Z",
  "detail": {},
  "segment": { "id": 22, "external_id": "story-123", "headline": "…", "kind": "breaking",
               "status": "approved", "version": 1, "playback_state": "on_air" },
  "control": { "state": "live", "on_air_id": 22, "note": null, "auto_live": false, "updated_at": "…" }
}
```

Always verify the signature on the **raw** body before trusting it:

```js
import crypto from 'node:crypto'

export function verifyZaid (rawBody, header, secret) {
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(want), b = Buffer.from(String(header || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

Answer `2xx` quickly (under 5 s); do slow work after answering. Delivery is best effort with no retry, so treat the
webhook as a live feed and use `GET /api/v1/log` or `GET /api/v1/segments` as the source of truth.
**Send test event** on the console checks your URL. Measured locally: 102 events in one show, all delivered and
verified, 15–20 ms each.

Events you will see: `created`, `edited`, `approved`, `withdrawn`, `deleted`, `preparing`, `ready`, `on_air`,
`done`, `blocked`, `studio_preparing`, `studio_ready`, `studio_live`, `studio_ended`, `rundown_cleared`,
`runway_started`, `runway_failed`, `voice_only`, `test`.

## Relaying to many clients (the "proxy" pattern)

The webhook lets your backend act as a real-time proxy: Zaid → your endpoint → whatever your clients already listen
to. The webhook receiver does three things: verify, transform, publish.

```js
// Express example: verify, then fan out to your own channel (Socket.IO, Pusher, Ably, Redis pub/sub…)
app.post('/zaid-events', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyZaid(req.body, req.get('x-zaid-signature'), process.env.ZAID_WEBHOOK_SECRET)) return res.sendStatus(401)
  res.sendStatus(204)                                  // answer first
  const e = JSON.parse(req.body)
  io.to('newsroom').emit('zaid', e)                    // your control room
  if (e.event === 'done' && e.segment?.external_id) markAsBroadcast(e.segment.external_id)   // your CMS
})
```

### With Supabase Realtime

You do **not** need Supabase for Zaid: the backend keeps its own rundown in `data/state.json`. Use Supabase only if
your website already uses it, or if you want a hosted real-time channel without running your own socket server.

**Use your own Supabase project.** Create a new one (or use the one your newsroom already has).
Do not use the Supabase project from Hussain's first prototype (`news-anchor-demo`): it was a throwaway test and
will be deleted.

How the first prototype used Supabase, and how to do the same with Zaid's webhook:

```
 Prototype (Nov 2026):  newsroom site ──insert──► Supabase table ──Realtime──► anchor screens
 With Zaid:            Zaid webhook ──► Edge Function ──insert──► Supabase table ──Realtime──► your pages
```

1. Table (SQL editor):

```sql
create table public.zaid_events (
  id bigint generated always as identity primary key,
  event text not null,
  segment jsonb,
  control jsonb,
  detail jsonb,
  at timestamptz not null default now()
);
alter table public.zaid_events enable row level security;
create policy "anyone can read" on public.zaid_events for select to anon using (true);  -- events hold no secrets
alter publication supabase_realtime add table public.zaid_events;
```

2. Edge Function `zaid-events` (receives the webhook, verifies, inserts). Set its secret
   `ZAID_WEBHOOK_SECRET` to the signing secret from the console, and deploy it **without** JWT verification
   (`supabase functions deploy zaid-events --no-verify-jwt`), because Zaid signs with HMAC instead:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const secret = Deno.env.get('ZAID_WEBHOOK_SECRET')!
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function sign (body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return 'sha256=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async req => {
  const body = await req.text()
  const got = req.headers.get('x-zaid-signature') ?? ''
  const want = await sign(body)
  if (got.length !== want.length || got !== want) return new Response('bad signature', { status: 401 })
  const e = JSON.parse(body)
  await db.from('zaid_events').insert({ event: e.event, segment: e.segment, control: e.control, detail: e.detail, at: e.at })
  return new Response(null, { status: 204 })
})
```

3. Webhook URL on the console: `https://<project-ref>.supabase.co/functions/v1/zaid-events` → **Send test event**.

4. Any page subscribes:

```js
supabase.channel('zaid')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'zaid_events' }, ({ new: e }) => {
    if (e.event === 'on_air') showOnAir(e.segment.headline)
  })
  .subscribe()
```

Keep the service-role key only inside the Edge Function. Pages use the anon key, which can only read this table.

## C. Viewers: LiveKit data messages

Inside the broadcast, Zaid sends `{ type: 'segment', id, kind, headline, script }` when a story starts and
`{ type: 'end' }` when the show ends, on topic `zaid`. They arrive in step with the voice, so use them for captions
and lower-thirds on the viewer page. See [05-connect-your-website.md](05-connect-your-website.md).

## Sending events *into* Zaid

The other direction (your newsroom → Zaid) is the API: `POST /segments`, `/breaking`, `/broadcast/*`.
If your newsroom already publishes approved stories to a queue or a Supabase table, add a small worker or database
webhook that calls these endpoints; changes reach the air at the next story boundary.
