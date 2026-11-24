# 5. Connect your website

First add your site's address on the console → **Website & API** → "Allowed website addresses" (for example
`https://news.example.com`). That allows the iframe and the browser calls below. No API key is used in the browser.

## Option A: embed the watch page (simplest)

```html
<iframe src="https://zaid.example.com/watch?embed=1"
        allow="autoplay" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

`embed=1` hides the page header. The viewer clicks **Watch live** once (browsers block sound until a click), then sees
Zaid's face (or a placeholder in voice-only mode), the red headline bar ("عاجل" or "Breaking" for breaking news, right to left for Arabic) and the caption.

## Option B: your own player

1. Get a watch-only token: `GET https://zaid.example.com/api/public/viewer-token` → `{ url, token, room }`
   (valid 2 hours, can only subscribe).
2. Join the room with [livekit-client](https://docs.livekit.io/reference/client-sdk-js/) and attach the tracks.
3. Read Zaid's data messages (topic `zaid`) for headlines and captions.

```js
import { Room, RoomEvent, Track } from 'livekit-client'

const player = document.querySelector('#player')
const caption = document.querySelector('#caption')

document.querySelector('#watch').onclick = async () => {
  const { url, token } = await fetch('https://zaid.example.com/api/public/viewer-token').then(r => r.json())
  const room = new Room({ adaptiveStream: true })

  room.on(RoomEvent.TrackSubscribed, track => {
    const el = track.attach()                        // <video> = Runway face, <audio> = Zaid's voice
    if (track.kind === Track.Kind.Video) player.replaceChildren(el)
    else document.body.append(el)
  })
  room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()))

  room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    if (topic !== 'zaid') return
    const e = JSON.parse(new TextDecoder().decode(payload))
    if (e.type === 'segment') caption.textContent = (e.kind === 'breaking' ? 'عاجل · ' : '') + e.headline
    if (e.type === 'end') caption.textContent = 'انتهى البث'
  })

  await room.connect(url, token)
  await room.startAudio()                           // inside the click handler
}
```

Data messages:

| `type` | Fields | When |
|---|---|---|
| `segment` | `id`, `kind` (`normal`/`breaking`), `headline`, `script` | When Zaid starts reading a segment |
| `end` | | When the show ends |

## Show "live now" on your home page

`GET /api/public/status` → `{ state, onAir: { id, headline, kind } | null, face }`.
`state` is `idle`, `preparing`, `ready`, `live` or `ended`. Poll it every 10–30 s to show a "LIVE" badge.

## Notes

- A viewer who joins mid-segment hears from that moment on; the caption appears with the next segment.
- Each viewer is a LiveKit participant: LiveKit minutes and bandwidth grow with the audience. For very large
  audiences, look at LiveKit's egress to HLS/RTMP (not built here).
- Mobile Safari needs the click too, and `playsinline` on the video (the watch page sets it).
