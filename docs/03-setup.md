# 3. Setup

## A. Run the backend

**With Node:**

```bash
git clone https://github.com/hussain-alayfei/agent_sync.git zaid && cd zaid
npm ci
ADMIN_PASSWORD='a-long-password' PORT=8080 npm start
```

**With Docker:**

```bash
docker build -t zaid-backend .
docker run -d --name zaid --restart unless-stopped -p 8080:8080 \
  -v zaid-data:/data -e ADMIN_PASSWORD='a-long-password' zaid-backend
```

Without `ADMIN_PASSWORD`, the first start prints a random password in the console and saves it in
`DATA_DIR/admin-password.txt`.

Put HTTPS in front (for example Caddy: `zaid.example.com { reverse_proxy localhost:8080 }`).
Check it is up: `GET https://zaid.example.com/health` → `{"ok":true}`.

## B. Fill the console

Open `https://zaid.example.com/admin`, sign in, and go to **Connections**.

1. **LiveKit**: Server URL, API key, API secret → **Test connection** → "Connected".
2. **ElevenLabs**: API key, voice ID → **Test connection** → "Voice found: …" → **Play a voice sample** to hear the exact voice
   (costs a few credits).
3. **Runway** (optional): API secret, character ID, and the character type (your own or a Runway preset) → **Test connection** → shows
   the credit balance and finds the character.
4. **Save connections**. The presenter restarts with the new keys. Wait until the sidebar shows
   **"Presenter: connected"**.
5. **Website & API**: copy the **API key** into your backend's secrets, and add your website's address(es) under
   "Allowed website addresses" (for example `https://news.example.com`) → **Save**. Optionally set the **Event webhook**.
6. **Settings → Admin password**: change it to your own. Set the presenter name there too.

Keys are stored only on this server and never shown again (only the last 4 characters). A key typed on the
console wins over the same name in the environment. To set keys from your container's secrets instead, use the
variables listed in the main README.

## C. First test (5 minutes)

1. Console → **Studio** → **Load demo stories** (3 approved demo stories).
2. **Prepare**. The light in the sidebar goes from amber "Preparing" to green "Ready to go live" in a few seconds.
3. Open `/watch` in another tab and click **Watch live**.
4. **Go live**. The light turns red with a timer; Zaid reads the three stories.
5. While story 2 plays, add a story with **Breaking news** ticked. It plays right after story 2.
6. **End broadcast**.

The Studio's **Activity** list and the **Presenter** log show every step (`preparing`, `ready`, `on_air`, `done`,
`runway_started` or `runway_failed` with Runway's error text).

## D. Several studios or environments

One backend = one studio = one LiveKit room. For staging + production, or several channels, run one backend each
with a different **room name** and **agent name** (console → Settings). Two backends with the same agent name on
the same LiveKit project would steal each other's jobs.
