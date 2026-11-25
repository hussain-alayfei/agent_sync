// Settings: the provider keys entered on the admin page, plus a few options.
// Stored in DATA_DIR/settings.json on this server. A value saved on the admin page wins over an
// environment variable of the same name; the environment is only a fallback (handy for Docker).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'))
const FILE = path.join(DATA_DIR, 'settings.json')

// The 7 keys the admin page asks for. `env` lists the environment names read as a fallback.
export const FIELDS = [
  { key: 'LIVEKIT_URL', group: 'livekit', label: 'Server URL', secret: false, placeholder: 'wss://your-project.livekit.cloud' },
  { key: 'LIVEKIT_API_KEY', group: 'livekit', label: 'API key', secret: true },
  { key: 'LIVEKIT_API_SECRET', group: 'livekit', label: 'API secret', secret: true },
  { key: 'ELEVENLABS_API_KEY', group: 'elevenlabs', label: 'API key', secret: true },
  { key: 'ELEVENLABS_VOICE_ID', group: 'elevenlabs', label: 'Voice ID (the presenter’s voice)', secret: false, env: ['ELEVENLABS_VOICE_ID', 'ZAID_VOICE_ID'], placeholder: 'e.g. VyVk2NYstrQNErJAO6Ko' },
  { key: 'RUNWAYML_API_SECRET', group: 'runway', label: 'API secret', secret: true },
  { key: 'RUNWAY_AVATAR_ID', group: 'runway', label: 'Character (avatar) ID', secret: false, env: ['RUNWAY_AVATAR_ID', 'RUNWAY_PRESET_ID'] }
]

// Options with defaults (not secrets).
export const OPTIONS = {
  RUNWAY_AVATAR_TYPE: process.env.RUNWAY_PRESET_ID && !process.env.RUNWAY_AVATAR_ID ? 'preset' : 'custom',
  ROOM_NAME: process.env.ZAID_ROOM || 'zaid-live',
  AGENT_NAME: process.env.ZAID_AGENT_NAME || 'zaid',
  LANGUAGE: 'ar',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
  PRESENTER_NAME: process.env.PRESENTER_NAME || 'Zaid',
  WEBHOOK_URL: process.env.WEBHOOK_URL || ''
}

let data = { values: {}, options: {}, adminHash: null, apiKey: null, webhookSecret: null, updatedAt: null }

export function load () {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch {}
  if (!data.apiKey) { data.apiKey = newApiKey(); persist() }
  if (!data.webhookSecret) { data.webhookSecret = 'whsec_' + crypto.randomBytes(24).toString('base64url'); persist() }
  return data
}

function persist () {
  data.updatedAt = new Date().toISOString()
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

export function newApiKey () { return 'zk_' + crypto.randomBytes(24).toString('base64url') }

const field = key => FIELDS.find(f => f.key === key)

function fromEnv (key) {
  for (const n of field(key)?.env || [key]) if (process.env[n]) return process.env[n].trim()
  return undefined
}

export function get (key) {
  if (field(key)) return data.values[key] || fromEnv(key) || ''
  return data.options[key] ?? OPTIONS[key]
}

export function source (key) {
  if (data.values[key]) return 'saved'
  if (fromEnv(key)) return 'environment'
  return 'missing'
}

// What the admin page may see: never a secret, only its last 4 characters.
export function describe () {
  return {
    fields: FIELDS.map(f => {
      const v = get(f.key)
      return {
        key: f.key, group: f.group, label: f.label, secret: f.secret, placeholder: f.placeholder || '',
        source: source(f.key),
        value: f.secret ? '' : v,
        hint: f.secret && v ? '••••' + v.slice(-4) : ''
      }
    }),
    options: Object.fromEntries(Object.keys(OPTIONS).map(k => [k, get(k)])),
    updatedAt: data.updatedAt
  }
}

// values: { KEY: 'new value' | null (remove) }; empty strings are ignored (keep current).
export function save ({ values = {}, options = {} }) {
  const changed = new Set()
  for (const [k, v] of Object.entries(values)) {
    if (!field(k)) continue
    if (v === null) { if (data.values[k]) { delete data.values[k]; changed.add(field(k).group) } continue }
    const t = String(v).trim()
    if (t && t !== data.values[k]) { data.values[k] = t; changed.add(field(k).group) }
  }
  for (const [k, v] of Object.entries(options)) {
    if (!(k in OPTIONS)) continue
    const t = String(v ?? '').trim()
    if (k === 'RUNWAY_AVATAR_TYPE' && !['custom', 'preset'].includes(t)) continue
    if ((k === 'ROOM_NAME' || k === 'AGENT_NAME') && !/^[A-Za-z0-9_-]{1,64}$/.test(t)) throw Object.assign(new Error(`${k}: letters, digits, - and _ only`), { status: 400 })
    if (k === 'LANGUAGE' && !/^[a-z]{2,3}$/.test(t)) continue
    if (k === 'PRESENTER_NAME' && (!t || t.length > 40)) throw Object.assign(new Error('Presenter name: 1 to 40 characters'), { status: 400 })
    if (k === 'WEBHOOK_URL' && t && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(t)) throw Object.assign(new Error('Webhook URL must start with https:// (http:// only for localhost)'), { status: 400 })
    if (t !== String(get(k))) { data.options[k] = t; changed.add(['ALLOWED_ORIGINS', 'WEBHOOK_URL'].includes(k) ? 'web' : 'worker') }
  }
  if (changed.size) persist()
  return changed
}

// Values for a test: what the form holds, else what is saved.
export function merged (values = {}) {
  const out = {}
  for (const f of FIELDS) out[f.key] = (values[f.key] && String(values[f.key]).trim()) || get(f.key)
  out.RUNWAY_AVATAR_TYPE = values.RUNWAY_AVATAR_TYPE || get('RUNWAY_AVATAR_TYPE')
  out.LANGUAGE = get('LANGUAGE')
  return out
}

export const ready = {
  livekit: () => !!(get('LIVEKIT_URL') && get('LIVEKIT_API_KEY') && get('LIVEKIT_API_SECRET')),
  elevenlabs: () => !!(get('ELEVENLABS_API_KEY') && get('ELEVENLABS_VOICE_ID')),
  runway: () => !!(get('RUNWAYML_API_SECRET') && get('RUNWAY_AVATAR_ID'))
}

export function allowedOrigins () {
  return String(get('ALLOWED_ORIGINS')).split(/[\s,]+/).map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
}

// ---------- admin password + integration key ----------
export function apiKey () { return data.apiKey }
export function rotateApiKey () { data.apiKey = newApiKey(); persist(); return data.apiKey }
export function webhookSecret () { return data.webhookSecret }
export function rotateWebhookSecret () { data.webhookSecret = 'whsec_' + crypto.randomBytes(24).toString('base64url'); persist(); return data.webhookSecret }

export function hasPassword () { return !!(data.adminHash || process.env.ADMIN_PASSWORD) }

export function setPassword (pw) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(pw, salt, 32)
  data.adminHash = salt.toString('hex') + ':' + hash.toString('hex')
  persist()
}

export function checkPassword (pw) {
  if (typeof pw !== 'string' || !pw) return false
  const env = process.env.ADMIN_PASSWORD
  if (env && safeEqual(pw, env)) return true
  if (!data.adminHash) return false
  const [salt, hash] = data.adminHash.split(':')
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'))
}

export function safeEqual (a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

// First start without ADMIN_PASSWORD: make one, print it once, keep a copy in DATA_DIR.
export function ensurePassword () {
  if (hasPassword()) return null
  const pw = crypto.randomBytes(9).toString('base64url')
  setPassword(pw)
  fs.writeFileSync(path.join(DATA_DIR, 'admin-password.txt'), pw + '\n', { mode: 0o600 })
  return pw
}
