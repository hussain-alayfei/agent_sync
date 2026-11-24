// "Test" buttons on the admin page: each one makes a read-only call to the provider.
// None of them spends credits except the voice sample (a short sentence, a few ElevenLabs credits).
import { RoomServiceClient } from 'livekit-server-sdk'
import { prepareAudio, toWav } from './tts.js'

const RUNWAY_API = 'https://api.dev.runwayml.com'
const RUNWAY_VERSION = '2024-11-06'
export const livekitHttp = url => String(url || '').replace(/^wss?:\/\//, 'https://')

async function body (r) {
  const t = await r.text()
  try { const j = JSON.parse(t); return j.detail?.message || j.detail?.status || j.error || j.message || t } catch { return t.slice(0, 200) }
}

export async function testLivekit (v) {
  if (!v.LIVEKIT_URL || !v.LIVEKIT_API_KEY || !v.LIVEKIT_API_SECRET) return { ok: false, message: 'Fill the URL, the API key and the API secret.' }
  if (!/^wss?:\/\//.test(v.LIVEKIT_URL)) return { ok: false, message: 'The URL should start with wss://' }
  try {
    const rooms = await new RoomServiceClient(livekitHttp(v.LIVEKIT_URL), v.LIVEKIT_API_KEY, v.LIVEKIT_API_SECRET).listRooms()
    return { ok: true, message: `Connected. ${rooms.length} room(s) open now.` }
  } catch (e) {
    return { ok: false, message: 'LiveKit refused: ' + (e.message || e) }
  }
}

export async function testElevenlabs (v) {
  if (!v.ELEVENLABS_API_KEY) return { ok: false, message: 'Fill the API key.' }
  if (!v.ELEVENLABS_VOICE_ID) return { ok: false, message: 'Fill the voice ID.' }
  const r = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(v.ELEVENLABS_VOICE_ID)}`, { headers: { 'xi-api-key': v.ELEVENLABS_API_KEY } })
  if (r.ok) {
    const j = await r.json()
    return { ok: true, message: `Key works. Voice found: “${j.name}”.` }
  }
  const msg = await body(r)
  if (r.status === 401 && /permission/i.test(msg)) return { ok: null, message: 'The key works but cannot read voices (missing "voices_read" permission). Use "Play sample" to check the voice.' }
  if (r.status === 401) return { ok: false, message: 'API key rejected: ' + msg }
  if (r.status === 404 || r.status === 400) return { ok: false, message: 'Voice ID not found in this ElevenLabs account: ' + msg }
  return { ok: false, message: `ElevenLabs ${r.status}: ${msg}` }
}

export async function sampleVoice (v, text) {
  const a = await prepareAudio(text || 'مساء الخير، وأهلاً بكم في نشرة الأخبار.', {
    apiKey: v.ELEVENLABS_API_KEY, voiceId: v.ELEVENLABS_VOICE_ID, language: v.LANGUAGE
  })
  return { wav: toWav(a.pcm), prepareMs: a.prepareMs, audioMs: a.audioMs }
}

export async function testRunway (v) {
  if (!v.RUNWAYML_API_SECRET) return { ok: false, message: 'Fill the API secret.' }
  const headers = { Authorization: `Bearer ${v.RUNWAYML_API_SECRET}`, 'X-Runway-Version': RUNWAY_VERSION }
  const r = await fetch(`${RUNWAY_API}/v1/organization`, { headers })
  if (!r.ok) return { ok: false, message: `Runway refused the key (${r.status}): ${await body(r)}` }
  const org = await r.json()
  const credits = org.creditBalance ?? org.credit_balance
  let message = 'Key works.' + (credits !== undefined ? ` Credit balance: ${credits}.` : '')
  let ok = true
  if (credits === 0) { ok = null; message += ' The balance is 0: buy API credits in the Runway developer portal before going live.' }
  if (!v.RUNWAY_AVATAR_ID) return { ok: null, message: message + ' Fill the character (avatar) ID.' }
  if (v.RUNWAY_AVATAR_TYPE === 'preset') return { ok, message: message + ` Preset “${v.RUNWAY_AVATAR_ID}” will be used (presets are checked when the broadcast starts).` }
  const a = await fetch(`${RUNWAY_API}/v1/avatars/${encodeURIComponent(v.RUNWAY_AVATAR_ID)}`, { headers })
  if (a.ok) {
    const j = await a.json()
    return { ok, message: message + ` Character found${j.name ? `: “${j.name}”` : ''}${j.status ? ` (${j.status})` : ''}.` }
  }
  if (a.status === 404) return { ok: false, message: message + ' But this character ID was not found in this Runway account.' }
  return { ok: null, message: message + ` The character could not be checked (${a.status}); it will be checked when the broadcast starts.` }
}

export const TESTS = { livekit: testLivekit, elevenlabs: testElevenlabs, runway: testRunway }
