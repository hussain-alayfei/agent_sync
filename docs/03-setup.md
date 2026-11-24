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

## B. Fill the admin page

Open `https://zaid.example.com/admin` and sign in.

1. **LiveKit**: Server URL, API key, API secret → **Test** → "Connected".
2. **ElevenLabs**: API key, voice ID → **Test** → "Voice found: …" → **Play sample** to hear the exact voice
   (costs a few credits).
3. **Runway** (optional): API secret, character ID, and the type (custom character or preset) → **Test** → shows
   the credit balance and finds the character.
4. **Save**. The presenter restarts with the new keys. Wait until the header shows
   **"Presenter: connected to LiveKit"**.
5. **Connect your website**: copy the **API key** into your backend's secrets, and add your website's origin(s) under
   "Allowed website origins" (for example `https://news.example.com`) → **Save origins**.
6. **Admin password**: change it to your own.

Keys are stored only on this server and never shown again (only the last 4 characters). A key typed on the
admin page wins over the same name in the environment. To set keys from your container's secrets instead, use the
variables listed in the main README.

## C. First test (5 minutes)

1. Open `/studio` → «ديمو (3 أخبار)» (loads 3 approved demo segments).
2. «تجهيز الاستوديو» (prepare). The state goes `يجهّز` → `جاهز للبث` in a few seconds.
3. Open `/watch` in another tab and click «شاهد البث».
4. «على الهواء» (go live). Zaid reads the three segments.
5. While segment 2 plays, add a story in the form with «خبر عاجل» ticked. It plays right after segment 2.
6. «إنهاء البث» (end).

The studio log and the admin page's presenter log show every step (`preparing`, `ready`, `on_air`, `done`,
`runway_started` or `runway_failed` with Runway's error text).

## D. Several studios or environments

One backend = one studio = one LiveKit room. For staging + production, or several channels, run one backend each
with a different **room name** and **agent name** (admin page → Advanced). Two backends with the same agent name on
the same LiveKit project would steal each other's jobs.
