# Zaid backend — API reference

Base URL: `https://<your-zaid-server>/api/v1`
Every `/api/v1` call needs the header `x-api-key: <key>` (copy it from the admin page → "Connect your website").
Call it **from your backend only**: never put the key in browser code. Bodies are JSON (`content-type: application/json`).
Errors come back as `{ "error": "message" }` with a status code: 400 bad input, 401 wrong key, 404 not found,
409 not allowed in the current state, 413 body too large, 502/503 a provider or the presenter is not ready.

## How a broadcast works

1. Your system adds **segments** (a headline + the exact script Zaid reads). Only **approved** segments are read.
2. `POST /broadcast/start` (or `prepare` then `live`). The presenter joins the LiveKit room and prepares the
   opening audio. With `start` it goes on air as soon as the audio is ready (2–4 s).
3. On air, Zaid reads approved segments in `position` order. While one segment plays, the next two are prepared.
4. While live you can add, edit, approve or withdraw segments. A breaking story is read **right after the segment
   on air**. A withdrawn segment is skipped. Editing the script creates a new version that must be approved again
   (Zaid never reads an unapproved version).
5. `POST /broadcast/end`. Zaid finishes and leaves; the room closes.

Zaid keeps waiting for new approved segments until you end the broadcast.

## Segment object

```json
{
  "id": 5,
  "external_id": "story-123",
  "headline": "عنوان الخبر",
  "script": "النص الذي يقرؤه زيد حرفياً",
  "version": 2,
  "status": "approved",
  "kind": "normal",
  "position": 50,
  "playback_state": "done",
  "prepared_version": 2,
  "audio_ms": 6320,
  "prepare_ms": 1312,
  "created_at": "2026-11-24T13:55:30.000Z",
  "updated_at": "2026-11-24T13:56:17.000Z"
}
```

| Field | Values |
|---|---|
| `status` | `draft` (not read), `approved`, `withdrawn` |
| `kind` | `normal`, `breaking` |
| `playback_state` | `queued` → `preparing` → `ready` → `on_air` → `done`; or `blocked` (withdrawn) |
| `position` | reading order, lower first (new segments get last + 10) |
| `audio_ms` / `prepare_ms` | length of the prepared audio / how long ElevenLabs took |

Limits: `script` up to 3000 characters, `headline` up to 200. Credits are spent per character of `script`.

## Endpoints

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/status` | | Studio state, segment on air, which services are set, presenter state |
| GET | `/segments` | | The rundown in reading order. `?externalId=story-123` filters by your own id |
| POST | `/segments` | `headline`, `script`, `approved` (bool) or `status`, `kind`, `position`, `externalId` | Add a segment (draft unless approved). Returns 201 + the segment |
| GET | `/segments/{id}` | | One segment |
| PATCH | `/segments/{id}` | any of `headline`, `script`, `position`, `status` | Edit. A new `script` = new version + back to draft (send `"status":"approved"` in the same call to approve it) |
| POST | `/segments/{id}/approve` | | Approve |
| POST | `/segments/{id}/withdraw` | | Withdraw (it will not be read) |
| DELETE | `/segments/{id}` | | Remove (not while on air) |
| POST | `/breaking` | `headline`, `script` | Add an approved breaking segment; while live it is read right after the segment on air |
| POST | `/rundown/clear` | | Remove every segment (not while live) |
| POST | `/rundown/demo` | | Load 3 approved demo segments |
| POST | `/broadcast/start` | | Prepare and go live by itself |
| POST | `/broadcast/prepare` | `goLive` (bool, optional) | Presenter joins and prepares; state `preparing` → `ready` |
| POST | `/broadcast/live` | | Go live (from `ready`; from `preparing` it goes live when ready) |
| POST | `/broadcast/end` | | End the broadcast |
| GET | `/log?limit=60` | | Latest events, newest first |
| GET | `/events` | | Live updates (Server-Sent Events), see below |

Studio states (`control.state`): `idle`, `preparing`, `ready`, `live`, `ended`.

### Examples

```bash
KEY=zk_...           # from the admin page
API=https://zaid.example.com/api/v1

# Add an approved story (Zaid reads the script word for word)
curl -X POST $API/segments -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"headline":"جلسة حكومية","script":"تعقد الحكومة اليوم جلسة استثنائية...","approved":true,"externalId":"story-123"}'

# Start
curl -X POST $API/broadcast/start -H "x-api-key: $KEY"

# Breaking news while live
curl -X POST $API/breaking -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"headline":"عاجل","script":"خبر عاجل: ..."}'

# Correct a script (new version, approved in the same call)
curl -X PATCH $API/segments/12 -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"script":"النص المصحح","status":"approved"}'

# End
curl -X POST $API/broadcast/end -H "x-api-key: $KEY"
```

Node.js:

```js
const zaid = (method, path, body) => fetch(process.env.ZAID_API + path, {
  method,
  headers: { 'x-api-key': process.env.ZAID_KEY, 'content-type': 'application/json' },
  body: body && JSON.stringify(body)
}).then(r => r.json())

await zaid('POST', '/segments', { headline, script, approved: true, externalId: story.id })
await zaid('POST', '/broadcast/start')
```

### Live updates (`GET /events`)

Server-Sent Events. Send the key as the `x-api-key` header (server side), or as `?key=` if your client cannot set
headers. Events:

- `rundown`: `{ control, segments, presenter }`, sent on every change
- `log`: one log entry `{ id, event, segment_id, version, detail, at }`

Useful log events: `created`, `edited`, `approved`, `withdrawn`, `preparing`, `ready`, `on_air`, `done`, `blocked`,
`studio_live`, `studio_ended`, `runway_started`, `runway_failed` (with the provider's error), `voice_only`.

## For your front end (no key)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/public/status` | `{ state, onAir: { id, headline, kind } \| null, face }` |
| GET | `/api/public/viewer-token` | `{ url, token, room }`: a LiveKit token that can only watch (2 hours) |

Add your site's origin (for example `https://news.example.com`) under "Allowed website origins" on the admin page,
so the browser may call these and embed the watch page.

**Simplest:** embed the watch page.

```html
<iframe src="https://zaid.example.com/watch?embed=1" allow="autoplay" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

**Your own player** with [livekit-client](https://docs.livekit.io/reference/client-sdk-js/):

```js
import { Room, RoomEvent, Track } from 'livekit-client'
const { url, token } = await fetch('https://zaid.example.com/api/public/viewer-token').then(r => r.json())
const room = new Room()
room.on(RoomEvent.TrackSubscribed, track => {
  const el = track.attach()                       // <video> for Runway's face, <audio> for the voice
  document.querySelector('#player').append(el)
})
room.on(RoomEvent.DataReceived, (payload, p, kind, topic) => {
  if (topic !== 'zaid') return
  const e = JSON.parse(new TextDecoder().decode(payload))
  // { type: 'segment', id, kind, headline, script }  or  { type: 'end' }
})
await room.connect(url, token)
await room.startAudio()                           // call from a click (browsers block sound before one)
```
