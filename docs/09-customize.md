# 9. Make it yours

Zaid is a working example, not a fixed product. Every part can be changed without touching the rest.

## Without code (console → Settings and Connections)

| Change | Where |
|---|---|
| The presenter's name (shown to viewers and on the console) | Settings → Presenter name |
| The voice | Connections → ElevenLabs voice ID (any voice in your ElevenLabs account) |
| The face | Connections → Runway character ID, custom or preset; leave empty for voice only |
| The language | Settings → Speech language code (`ar`, `en`, …) and write the scripts in that language |
| Several channels or environments | One backend each, with its own room name and agent name |

## With code

| Part | File | Contract to keep |
|---|---|---|
| Speech provider or model | `lib/tts.js` | `prepareAudio(text, opts)` resolves to `{ pcm: Int16Array (mono, 24 kHz), audioMs, prepareMs }`. Any TTS that can return PCM works (another ElevenLabs model, Azure, Google, OpenAI) |
| Face provider | `agent.js` | LiveKit Agents has avatar plugins besides Runway; start the avatar session before `session.start`, as Runway is started now |
| Director rules (where breaking news goes, what is skipped) | `lib/rundown.js` → `place()` and `nextSegment()` | Pure functions over the segment list; easy to test |
| An AI director (reorder or trim by timing, pick the next story) | `lib/rundown.js` | Replace `place()` with a call to your model; keep the boundary check so only approved text is read |
| Where the rundown is stored | `lib/store.js` | Same methods (`segments`, `create`, `update`, `setStatus`, `playback`, `setControl`, …) and events (`change`, `log`); swap the JSON file for Postgres, Supabase or Redis if several servers must share it |
| Who may call the API | `server.js` → `hasKey()` | Today one API key; add per-client keys or your SSO here |
| Pages | `public/console.html`, `public/watch.html` | Plain HTML + JS against the same API; replace them with your own front end if you prefer |

## What to keep, whatever you change

- **Only approved text is spoken.** If you add a language model anywhere, it may suggest, reorder or summarise for
  an editor, but what goes on air is text a person approved.
- **Changes land at boundaries.** Never cut the presenter mid-sentence; check approval and version just before
  playing.
- **Prepare ahead.** Generating speech while the previous story plays is what makes the show feel live.
- **The broadcast plays to an empty room.** Viewers join a show already in progress; the presenter must not wait
  for them. (LiveKit's default agent audio output waits for a first listener; voice-only mode publishes its own
  track for this reason, see `agent.js`.)

## Not tied to one agent

The backend talks to the presenter through a small internal API (`lib/link.js`), and to your systems through
`/api/v1`, the webhook and LiveKit. You can run another agent in the same LiveKit room next to Zaid (a sign-language
avatar, a co-host, a moderator), or point several frontends at the same broadcast, without changing Zaid himself.
