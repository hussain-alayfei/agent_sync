# 6. Real time

"Live" here means: Zaid is in the room for the whole show, viewers see and hear him as he speaks, and newsroom
changes (approve, withdraw, edit, breaking) take effect **at the next segment boundary**, without stopping the show.

## Where the time goes

```
approve ─► (API, ms) ─► rundown ─► director tick (≤ 0.8 s) ─► ElevenLabs prepare (1–2 s) ─► waits for its turn
                                                                                              │
                                         boundary check (~0.1 s) + 150 ms pause ◄──────────────┘
                                                              │
                     audio frames ─► LiveKit room ─► Runway (lip-synced video) ─► viewers (WebRTC)
```

## Measured (2026-11-24, voice only, LiveKit region Saudi Arabia, backend on a local Windows PC)

| Step | Time |
|---|---|
| ElevenLabs `eleven_v4_turbo`, one segment of 75–110 characters (5–10 s of audio) | 1.1–1.9 s to prepare |
| ElevenLabs `eleven_v4` (default since 2026-11-25, the manager's choice), same 4-story show | 3.9–4.6 s to prepare per story; prepare → ready ≈ 9 s; gaps 0.15 s; breaking, edit and withdraw handled at boundaries |
| ElevenLabs `eleven_v3`, 4-story show, 90–150 characters each | 3.8–5.3 s to prepare (hidden: done while the previous story plays); prepare → ready ≈ 10 s; gaps 0.15 s; breaking news right after the story on air; an edited story played in its new version; a withdrawn story skipped |
| `prepare` → studio ready (opening audio done) | ≈ 4 s |
| Gap between two segments | ≈ 0.2–0.4 s |
| A full 3-story show with **no viewer connected** (start → last story read) | 37 s for 26.6 s of audio |
| Webhook delivery to a local receiver | 15–20 ms per event |
| Breaking news approved during a segment | read right after that segment; ≈ 1–1.5 s extra gap if its audio was not ready yet |
| Viewer audio delay (WebRTC) | not measured; WebRTC is usually well under a second |
| Runway face (start time, video delay, Arabic lip sync) | **not measured yet** (no Runway credits during the test) |

## How real time is kept

| Technique | Effect |
|---|---|
| **Prepare ahead**: the next two approved segments are turned into audio while the current one plays | No waiting at boundaries |
| **Raw PCM 24 kHz** from ElevenLabs, straight into LiveKit audio frames | No decoding or conversion on the way |
| **Boundary-only changes**: Zaid never interrupts himself | Clean on-air sound; breaking news waits at most one segment |
| **Short check at the boundary**: still approved, same version | Last-second withdrawals and edits are respected without blocking the show |
| **Background director** (every 0.8 s) | Blocks, moves and prepares while Zaid speaks |
| **One warm presenter process** | A new show starts without loading the agent from scratch |

## What makes it slower, and what to do

| Cause | Fix |
|---|---|
| Long segments (a 2000-character script) | Prepare time grows with length; split long stories into segments of 1–3 short paragraphs |
| Breaking news must wait for the current segment to end | Keep segments short (20–40 s), so the wait is short |
| Server far from LiveKit / ElevenLabs | Host the backend in or near the LiveKit region you chose; measure prepare time in the studio table |
| Busy or tiny server (CPU starved) | 2 vCPU; do not share the machine with heavy jobs. Log warnings "event loop blocked" mean the CPU is late |
| Editing a segment just before its turn | A new version needs approval and a new prepare (1–2 s); approve in the same call (`"status":"approved"`) |
| Viewers behind firewalls blocking UDP | LiveKit falls back to TCP/TLS: works, slightly more delay |
| Runway | Adds the character's own processing (not measured yet). If Runway fails, the show continues voice only and the log says why |

## Limits by design

- One show at a time per backend, up to 30 minutes of Runway character per show (`maxDuration` in `agent.js`).
- Zaid reads only approved text: there is no live improvisation, no audience questions, no LLM.
- A server restart ends a running show (the rundown is kept; segments that were on air are marked `done`).
- Scripts up to 3000 characters each.

## Measure it yourself

- Studio rundown: **Audio** (length) and **Prepared in** (prepare time) per story.
- `GET /api/v1/segments`: `audio_ms`, `prepare_ms`.
- `GET /api/v1/log`: timestamps of `ready`, `on_air` and `done` for every segment (gap = next `on_air` − previous `done`).
