# Zaid backend — live AI news presenter

Zaid reads your newsroom's **approved** stories live, word for word, with an ElevenLabs voice and (optionally)
a Runway character's face, broadcast through LiveKit. Your own website stays in charge of the news: it sends the
approved text here over a small API and shows the broadcast to viewers.

```
Your newsroom backend ──x-api-key──►  Zaid backend  (this folder, one Node process)
                                         ├─ /admin    the console: studio (rundown, approve, breaking, go live),
                                         │            connections (LiveKit, ElevenLabs, Runway keys + tests),
                                         │            website & API (API key, embed code, event webhook), presenter log
                                         ├─ /api/v1   the same controls for your backend (API.md)
                                         ├─ webhook   every event pushed, signed, to your systems (docs/08)
                                         └─ presenter (LiveKit Agent "Zaid", started and watched by the server)
                                               ├─ ElevenLabs (eleven_v3 by default): audio prepared ahead, segment by segment
                                               ├─ Runway Character: lip-syncs to that audio (optional)
                                               └─ LiveKit room: voice (+ face) + headline/caption data
Your website (viewers) ──/api/public/viewer-token or the /watch iframe──► LiveKit room
```

**Integration guide:** start with [docs/README.md](docs/README.md) (how it works, requirements, setup,
connecting your backend and website, real-time timings, troubleshooting). Endpoints: [API.md](API.md).

No language model reads the news: the approved script is spoken exactly as written. Zaid is the agent that
presents, keeps the order, prepares the next audio while one plays, puts breaking news right after the segment on
air, and skips anything withdrawn.

## What you need

| Service | What to bring | Where |
|---|---|---|
| LiveKit | Server URL (`wss://…`), API key, API secret | [LiveKit Cloud](https://cloud.livekit.io) → project → Settings → API keys (free tier is enough to test) |
| ElevenLabs | API key, voice ID | [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) → API keys; Voices → the voice → ID. The key needs text-to-speech (and "voices read" for the Test button) |
| Runway (optional) | API secret, character (avatar) ID | [Runway developer portal](https://dev.runwayml.com) → API keys; Characters. Needs API credits. Without Runway, Zaid broadcasts voice only |

The voice must exist in the same ElevenLabs account as the key (voices do not move between accounts).

## Run it

Needs Node.js 22 or newer and a machine that stays on (the presenter holds a live connection for the whole
broadcast). Serverless hosts (Vercel, Netlify functions) **cannot** run it.

```bash
npm install
npm start                      # http://localhost:8795  (PORT to change)
```

The first start prints an admin password and saves it in `data/admin-password.txt`
(or set `ADMIN_PASSWORD` yourself). Open `/admin`, sign in, and on **Connections** paste the keys, press **Test connection** for each service and
**Play a voice sample** to hear the voice, then **Save connections**. The presenter restarts with the new keys and
the sidebar shows "Presenter: connected".

Then on the console: **Studio** → **Load demo stories** → **Prepare** → open `/watch` and click **Watch live** → **Go live**.

### Docker

```bash
docker build -t zaid-backend .
docker run -d --name zaid -p 8080:8080 -v zaid-data:/data -e ADMIN_PASSWORD='choose-a-long-one' zaid-backend
```

Any host that runs a container all the time works (a VPS, Railway, Render, Fly.io, Azure Container Apps,
AWS ECS…). Put it behind HTTPS (the host's TLS or a reverse proxy such as Caddy/Nginx) and keep `/data` on a
persistent disk: it holds the keys and the rundown.

### Settings by environment (optional)

Keys typed on the console win; these are only a fallback, handy for container secrets.

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (8795; 8080 in Docker) |
| `DATA_DIR` | Where `settings.json` and `state.json` live (`./data`; `/data` in Docker) |
| `ADMIN_PASSWORD` | Admin password (always accepted while set) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | ElevenLabs |
| `RUNWAYML_API_SECRET`, `RUNWAY_AVATAR_ID` (or `RUNWAY_PRESET_ID`) | Runway |
| `ALLOWED_ORIGINS` | Your website origins, comma separated |
| `PRESENTER_NAME` | Name shown to viewers (default Zaid) |
| `TTS_MODEL` | Speech model: `eleven_v3` (default), `eleven_v4`, `eleven_v4_turbo`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_turbo_v2_5` |
| `WEBHOOK_URL` | Where to push every event (see docs/08-realtime-relay.md) |

## Connect your website

1. Console → **Website & API**: copy the API key into your backend's secrets, and add your site's
   address under "Allowed website addresses".
2. Your backend: when an editor approves a story, `POST /api/v1/segments` with `approved: true`; start with
   `POST /api/v1/broadcast/start`; breaking news with `POST /api/v1/breaking`; end with `POST /api/v1/broadcast/end`.
3. Your front end: embed `https://<zaid-server>/watch?embed=1`, or build your own player with a token from
   `GET /api/public/viewer-token`.

Everything is in [API.md](API.md).

## Files

| File | What |
|---|---|
| `server.js` | Web server: pages, admin API, `/api/v1`, `/api/public`, live events, starts the presenter |
| `agent.js` | The presenter (LiveKit Agent). Started by `server.js`; do not run it by hand |
| `lib/config.js` | Keys and options (`data/settings.json`), admin password, API key |
| `lib/store.js` | Rundown, studio state and log (`data/state.json`) |
| `lib/rundown.js` | Director rules and the on-air loop (prepare ahead, breaking insert, withdrawn blocked) |
| `lib/tts.js` | ElevenLabs speech → PCM 24 kHz (v3, v4, multilingual, flash over HTTP; v4 Turbo over the Text to Dialogue WebSocket) |
| `lib/checks.js` | The console's Test connection and Play a voice sample buttons |
| `lib/worker.js` | Starts, restarts and logs the presenter process |
| `public/` | `console.html` (the console at `/admin` and `/studio`), `watch.html` (viewer page) |

## Security

- Provider keys are stored only on this server (`data/settings.json`, file mode 600 on Linux) and are never sent
  back to a browser (the console shows the last 4 characters).
- Admin sign-in: scrypt-hashed password, HttpOnly SameSite=Strict session cookie (12 h, `Secure` behind HTTPS),
  10 attempts per 10 minutes per address. Sessions are in memory: a restart signs everyone out.
- `/api/v1` needs the API key (constant-time check). "Replace key" on the console revokes the old one at once.
- Viewers get LiveKit tokens that can only subscribe (no publishing), valid 2 hours.
- The presenter talks to the server over a loopback-only internal API with a random token per start.
- The presenter only joins a room this server asked for; leftover LiveKit jobs are refused.
- `/admin` and `/studio` cannot be framed; `/watch` can be framed only by the allowed origins.

## Costs and limits

- ElevenLabs: about 1 credit per character with `eleven_v3` (default), about half with `eleven_v4_turbo` or flash/turbo v2.5. Change it on the console → Settings → Speech model.
- Runway: billed per minute of character video (see Runway's API pricing); the session lasts at most 30 minutes
  per broadcast.
- LiveKit: participant and agent minutes (LiveKit Cloud has a free tier).
- One studio per server: one broadcast at a time, one LiveKit room (name set on the console → Settings). For several
  channels, run several servers with different room and agent names.
- Measured (2026-11-24, voice only, LiveKit Saudi Arabia region): preparing a segment 1.1–1.9 s for 5–10 s of
  audio, done while the previous one plays; gap between segments about 0.2–0.4 s; prepare → on air about 4 s.
  Not yet measured: the Runway face (lip sync on Arabic, video delay).

## Troubleshooting

| Symptom | Look at |
|---|---|
| Presenter "waiting for LiveKit keys" | Fill and save the three LiveKit fields |
| Presenter "stopped, restarting" | Admin → Presenter log. Usually a wrong LiveKit key/URL |
| Prepare says the presenter is not connected | Wait until the console shows "Presenter: connected" |
| Broadcast ends with "failed: ElevenLabs…" | ElevenLabs key, voice ID or credits; use Test connection and Play a voice sample |
| No face, log shows `runway_failed` | The error text is in the log: credits, wrong character ID or type (custom vs preset) |
| Two servers on one LiveKit project | Give each a different agent name and room name (Advanced) |
