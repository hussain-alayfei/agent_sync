// The presenter process talks to the web server over a loopback-only internal API
// (one random token per server start). This replaces the database calls of the proof of concept.
const base = process.env.ZAID_INTERNAL_URL
const token = process.env.ZAID_INTERNAL_TOKEN

async function call (method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'x-internal-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}

export const db = {
  segments: () => call('GET', '/internal/segments'),
  segment: id => call('GET', `/internal/segments/${Number(id)}`),
  control: () => call('GET', '/internal/control'),
  setControl: (state, onAirId = null, note = null) => call('POST', '/internal/control', { state, onAirId, note }),
  playback: (id, state, extra = {}) => call('POST', '/internal/playback', { id, state, ...extra }),
  log: (event, detail = {}) => call('POST', '/internal/log', { event, detail })
}

export const env = {
  elevenKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID,
  language: process.env.ZAID_LANGUAGE || 'ar',
  runwaySecret: process.env.RUNWAYML_API_SECRET,
  runwayAvatar: process.env.RUNWAY_AVATAR_ID,
  runwayAvatarType: process.env.RUNWAY_AVATAR_TYPE || 'custom',
  agentName: process.env.ZAID_AGENT_NAME || 'zaid',
  presenterName: process.env.ZAID_PRESENTER_NAME || 'Zaid'
}
