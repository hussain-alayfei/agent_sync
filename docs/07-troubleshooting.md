# 7. Troubleshooting

Start with the console: the light in the sidebar, **Connections → Test connection**, and **Presenter** (state and log).
The Studio's **Activity** list shows every rundown event.

| Symptom | Likely cause | Fix |
|---|---|---|
| Presenter "waiting for LiveKit keys" | LiveKit fields empty | Fill the three LiveKit values and Save |
| Presenter "stopped, restarting" | Wrong LiveKit URL/key/secret, or no network to LiveKit | LiveKit **Test connection**; read the Presenter log |
| Prepare: "presenter is not connected to LiveKit yet" | Presenter still starting | Wait for "Presenter: connected" in the sidebar (a few seconds after saving or starting) |
| Studio stays on "Preparing" | The job did not reach this server (another server with the same agent name?) | Use a unique agent name per server (Settings); end and prepare again |
| Show ends with "failed: ElevenLabs …" | Key, voice ID, permissions or credits | ElevenLabs **Test connection** and **Play a voice sample** |
| ElevenLabs Test: "missing voices_read permission" | Restricted key | Fine for speech; check the voice with Play a voice sample, or give the key that permission |
| "Voice ID not found" | Voice is in another ElevenLabs account | Add the voice to the key's account, or use a key from the voice's account |
| No face, log shows `runway_failed` | No API credits, wrong character ID, or custom vs preset type wrong | Read the error in the log; Runway **Test connection** shows the balance and checks the character |
| Log shows `voice_only` | Runway keys not set | Expected without Runway |
| Viewer sees the page but hears nothing | The click did not happen, or the show is not live | Click **Watch live**; check `/api/public/status` |
| iframe is blank or refused | Your origin is not allowed | Website & API → Allowed website addresses (exact scheme + host, no trailing slash) |
| Browser calls to `/api/public/*` blocked by CORS | Same | Same |
| `401` from `/api/v1` | Wrong key, or someone pressed "Replace key" | Copy the current key from the console → Website & API |
| `409` on start | A show is already running | `POST /broadcast/end` first |
| Everyone signed out of the console | The server restarted (sessions are in memory) | Sign in again |
| Lost the admin password | | Set `ADMIN_PASSWORD` in the environment and restart; it always works while set |
| Warnings "event loop blocked" in the log | CPU too busy | Bigger server or fewer jobs on it |
| Webhook shows failures | Your endpoint was down, slow (> 5 s) or rejected the signature | **Send test event**; check you verify the raw body with the current signing secret |
| A story stays "On air" and never finishes (custom code) | LiveKit's default agent audio output waits for a first listener | Keep the presenter's own broadcast track (see 09-customize.md) |

When reporting a problem, include: the time, the studio state, the last 20 lines of the presenter log and the
segment ids involved. Never paste keys.
