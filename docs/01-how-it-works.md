# 1. How it works

## The parts

| Part | Role | Runs where |
|---|---|---|
| **Your newsroom** (backend + editors) | Writes, checks and approves stories. Owns the wording | Your servers |
| **Zaid backend** (this repo) | Keeps the rundown, runs the presenter, gives you an API, a web console and an event webhook | One always-on server (yours) |
| **Zaid, the presenter** | A LiveKit Agent: joins the studio room, reads approved segments in order, handles breaking news | Inside the Zaid backend (child process) |
| **ElevenLabs** | Zaid's voice: turns each approved script into audio (`eleven_v4_turbo`) | ElevenLabs cloud |
| **Runway** | Zaid's face: a Runway Character that lip-syncs to Zaid's audio and publishes video | Runway cloud |
| **LiveKit** | The live "TV channel": a WebRTC room that carries Zaid's audio and video to every viewer | LiveKit Cloud |
| **Your website** | Shows the room (iframe or your own player) | Viewers' browsers |

```
 Editors ─► Your backend ──(1) POST /api/v1/segments (approved)──► Zaid backend
                         ──(2) POST /api/v1/broadcast/start ─────►    │
                                                                       ▼
                                              Zaid presenter (LiveKit Agent)
                                     (3) script ──► ElevenLabs ──► audio (prepared ahead)
                                     (4) audio ──► LiveKit room ──► Runway Character
                                                                       │ lip-synced video + audio
                                                                       ▼
 Viewers ◄── Your website (iframe /watch or LiveKit player) ◄── LiveKit room
```

## Agent, not plain text-to-speech

Zaid is an **agent**: a participant that lives in the broadcast room for the whole show, keeps the running order,
prepares the next segment while one is on air, decides when breaking news goes in, skips withdrawn stories and ends
the show. ElevenLabs is only his mouth and Runway his face.

What Zaid does **not** do: he does not write or change the news. There is no language model between your approved
text and his voice. The script is spoken exactly as approved, so the newsroom stays responsible for every word.

## From "approved" to "heard": step by step

1. **Approve.** Your backend sends the segment: `headline`, `script` (the exact words), `approved: true`,
   and your own `externalId`. It enters the rundown in `position` order.
2. **Start.** `POST /broadcast/start`. The backend creates a fresh LiveKit room and dispatches Zaid into it.
3. **Prepare.** Zaid sends the first two approved scripts to ElevenLabs and receives raw audio (PCM 24 kHz).
   State: `preparing`, then `ready`. With `start`, the show goes live as soon as the opening audio is ready.
4. **On air.** For each segment, at the boundary, Zaid checks one last time that it is still approved and still the
   same version, then plays its audio into the room and sends the headline and script as a data message (for captions).
   Runway receives the same audio and returns the face, lip-synced. In voice-only mode Zaid publishes his own audio
   track, which plays on schedule even when no viewer is connected yet.
5. **Meanwhile.** Every 0.8 s the director checks the rundown: blocks withdrawn segments, moves approved breaking news
   right after the segment on air, and prepares the next two segments' audio.
6. **End.** `POST /broadcast/end`. Zaid finishes, closes the Runway session and leaves; the room closes.

## Rules the presenter enforces

| Rule | Why |
|---|---|
| Only `approved` segments are read | Nothing goes on air without an editor's approval |
| Changing a script creates a new version and puts it back to `draft` | An approval is for the exact words; new words need a new approval |
| The last check happens at the boundary | A story withdrawn or edited a second before its turn is not read |
| Breaking news goes **after** the segment on air, not in the middle of it | Zaid never cuts himself off mid-sentence |
| A segment on air or already played cannot be edited | The record matches what viewers heard |
| The presenter only joins rooms this backend asked for | A leftover LiveKit job cannot start a show on its own |

## Inside the backend

| File | Job |
|---|---|
| `server.js` | HTTP server: console (`/admin`, `/studio`), `/watch`, `/api/v1`, `/api/public`, live events, webhook; starts and restarts the presenter |
| `agent.js` | The presenter (LiveKit Agents for Node). Starts Runway if configured, then runs the rundown |
| `lib/rundown.js` | Director rules and the on-air loop |
| `lib/tts.js` | ElevenLabs `eleven_v4_turbo` over the Text to Dialogue WebSocket |
| `lib/store.js` | Rundown, studio state and log, saved in `data/state.json` |
| `lib/config.js` | Keys and options from the console (`data/settings.json`) |
