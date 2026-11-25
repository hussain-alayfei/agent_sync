# 2. Requirements

## Accounts and keys (7 values on the console → Connections)

| Service | Values | Where to get them | Notes |
|---|---|---|---|
| **LiveKit** | Server URL (`wss://…livekit.cloud`), API key, API secret | [cloud.livekit.io](https://cloud.livekit.io) → your project → Settings → API keys | Free tier is enough to test. Pick the region closest to your viewers |
| **ElevenLabs** | API key, voice ID | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) → API keys; Voices → the voice → copy ID | The key needs text-to-speech permission (and "voices read" for the Test button). **The voice must be in the same account as the key**; voices do not move between accounts |
| **Runway** (optional) | API secret, character (avatar) ID | [dev.runwayml.com](https://dev.runwayml.com) → API keys; Characters | Needs **API credits** (separate from a Runway app subscription). A custom character ID or a Runway preset. Without Runway, Zaid broadcasts voice only |

Choosing Zaid's voice: design or pick an Arabic male voice in ElevenLabs (Voice Design or the Voice Library added to
your account), check it with **Play a voice sample** on the console, then save its ID.

## Server

| Need | Why |
|---|---|
| **Always on** (a VPS, a container service such as Railway, Render paid, Fly.io, Azure Container Apps, AWS ECS) | The presenter holds a live connection for the whole show. Serverless functions (Vercel, Netlify, Lambda) **cannot** run it |
| Node.js 22+ (or the included Dockerfile) | LiveKit Agents for Node |
| 1 vCPU, 1 GB RAM minimum; 2 vCPU recommended | The agent mixes and sends audio in real time; a starved CPU delays audio. On a busy laptop the job start once timed out (we raised the limit to 60 s) |
| A persistent disk for `DATA_DIR` | Keeps the keys and the rundown across restarts |
| HTTPS in front (host TLS, Caddy or Nginx) | The admin password, API key and session cookie must never travel in clear text |
| Close to LiveKit's region | Every hop between server, ElevenLabs and LiveKit adds delay (see 06-real-time.md) |

## Network

Outbound from the server (no inbound ports needed except your HTTPS port):

| To | Protocol | For |
|---|---|---|
| `*.livekit.cloud` | HTTPS + WSS 443, WebRTC (UDP; falls back to TCP/TLS 443) | Room control, the presenter's connection, publishing audio |
| `api.elevenlabs.io` | WSS/HTTPS 443 | Speech |
| `api.dev.runwayml.com` | HTTPS 443 | Starting and stopping the Runway character session |

Viewers connect to LiveKit directly from their browsers (WebRTC). Corporate firewalls that block UDP still work
through LiveKit's TCP/TLS fallback, with a little more delay.

## Your side

| Who | Needs |
|---|---|
| Your backend | Store the Zaid API key as a secret; call `/api/v1` server to server (never from the browser) |
| Your website | Your origin added to "Allowed website addresses" on the console; one click from the viewer before sound can play (browser rule) |
| Your editors | Final scripts written to be **read aloud**: numbers as words, diacritics on names that can be read two ways, one idea per segment |

## Costs (to check against each provider's current price list)

| Service | Unit | Measured / rough |
|---|---|---|
| ElevenLabs `eleven_v4` (default) or `eleven_v3` | credits per character of script | about 1 credit per character (a 100-character segment ≈ 100 credits) |
| ElevenLabs `eleven_v4_turbo`, flash/turbo v2.5 | same | half or less (measured ≈ 0.24 credit per character on v4 Turbo) |
| Runway Characters | per minute of character session | billed by Runway per minute; one session per show, 30 minutes maximum per show in this code (`maxDuration`) |
| LiveKit | agent + participant minutes, bandwidth | free tier for tests |
| Server | per month | a small always-on VM or container |
