# 4. Connect your backend

Your backend talks to `https://<zaid>/api/v1` with the header `x-api-key: <key from the console → Website & API>`.
Server to server only: the key gives full control of the broadcast.

## Map your newsroom to Zaid

| In your newsroom | Call |
|---|---|
| A story reaches its final approved text | `POST /segments` with `approved: true` and your story id as `externalId` |
| An editor corrects an approved story | `PATCH /segments/{id}` with the new `script` and `"status":"approved"` (new version, re-approved) |
| A story is pulled | `POST /segments/{id}/withdraw` |
| Breaking news | `POST /breaking` (approved, read right after the segment on air) |
| The bulletin's running order | `position` on each segment (lower first), or send them in order (each new one goes last) |
| Bulletin starts | `POST /broadcast/start` |
| Bulletin ends | `POST /broadcast/end` |
| Next bulletin | `POST /rundown/clear`, then add the new segments |

Find a segment by your own id: `GET /segments?externalId=story-123`.

## A full bulletin (Node.js)

```js
const ZAID = process.env.ZAID_API            // https://zaid.example.com/api/v1
const KEY = process.env.ZAID_KEY

async function zaid (method, path, body) {
  const r = await fetch(ZAID + path, {
    method,
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: body && JSON.stringify(body)
  })
  const data = r.status === 204 ? null : await r.json()
  if (!r.ok) throw new Error(`Zaid ${r.status}: ${data?.error}`)
  return data
}

// 1. Load the bulletin
await zaid('POST', '/rundown/clear')
for (const story of bulletin.stories) {        // already approved by your editors
  await zaid('POST', '/segments', {
    headline: story.title,
    script: story.readAloudText,               // the exact words Zaid will say
    approved: true,
    externalId: String(story.id)
  })
}

// 2. Go live (prepares the opening audio, then goes on air by itself)
await zaid('POST', '/broadcast/start')

// 3. During the show
await zaid('POST', '/breaking', { headline: 'عاجل', script: 'خبر عاجل: ...' })
const [seg] = await zaid('GET', `/segments?externalId=${id}`)
await zaid('POST', `/segments/${seg.id}/withdraw`)

// 4. End
await zaid('POST', '/broadcast/end')
```

## Follow the show live

Two options: pull with Server-Sent Events (below), or let Zaid push every event to your URL with the signed
webhook ([08-realtime-relay.md](08-realtime-relay.md)).


`GET /api/v1/events` is a Server-Sent Events stream:

- `rundown`: `{ control, segments, presenter }` on every change (what is on air, ready, preparing, done)
- `log`: one event at a time (`on_air`, `done`, `blocked`, `runway_failed`, …)

```js
// Node 22+: read the stream with fetch
const r = await fetch(`${ZAID}/events`, { headers: { 'x-api-key': KEY } })
const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
for (let buf = ''; ;) {
  const { value, done } = await reader.read(); if (done) break
  buf += value
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2)
    const event = block.match(/^event: (.*)$/m)?.[1]
    const data = block.match(/^data: (.*)$/m)?.[1]
    if (event === 'log') console.log(JSON.parse(data).event)
  }
}
```

Use it to show "on air now" in your own control room, or to mark stories as broadcast in your CMS
(`log` event `done` with `segment_id`; look up its `external_id`).

## Status codes to handle

| Code | Meaning | Action |
|---|---|---|
| 400 | Bad input (missing script, script over 3000 characters…) | Fix the request |
| 401 | Wrong or missing API key | Check the key (it changes if someone presses "Replace key") |
| 404 | Segment not found | It was deleted or the rundown was cleared |
| 409 | Not allowed now (editing a segment on air, starting while a show runs, clearing while live) | Wait or end first |
| 502 / 503 | LiveKit, ElevenLabs or the presenter is not ready | Check the console; retry after a few seconds |

## Writing scripts for the voice

The script is read exactly as written, so write it for the ear:

- Numbers, dates and percentages as words (the model may read digits in the wrong form).
- Diacritics on names or words that can be read two ways.
- Short sentences; one story per segment (shorter segments are prepared faster, see 06-real-time.md).
- No headings, bullet points or links inside `script`; put the title in `headline`.
