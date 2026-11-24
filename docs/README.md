# Zaid — integration guide

How to run Zaid and connect him to your newsroom, written for the team that will integrate him.
Read in this order:

| # | File | What it answers |
|---|---|---|
| 1 | [01-how-it-works.md](01-how-it-works.md) | What Zaid is, the parts, and what happens from "story approved" to "viewer hears it" |
| 2 | [02-requirements.md](02-requirements.md) | Accounts, keys, server, network and costs you need before starting |
| 3 | [03-setup.md](03-setup.md) | Deploy the backend and fill the admin page, step by step |
| 4 | [04-connect-your-backend.md](04-connect-your-backend.md) | Send approved stories and control the broadcast from your backend |
| 5 | [05-connect-your-website.md](05-connect-your-website.md) | Show the live broadcast on your website |
| 6 | [06-real-time.md](06-real-time.md) | What "real time" means here: timings, limits, and how to keep it fast |
| 7 | [07-troubleshooting.md](07-troubleshooting.md) | Problems we have met and how to fix them |

The full endpoint list is in [../API.md](../API.md).

**In one sentence:** your editors approve a story, your backend sends its exact text to Zaid's API,
Zaid's voice (ElevenLabs) and face (Runway) present it live in a LiveKit room, and your website shows that room.
