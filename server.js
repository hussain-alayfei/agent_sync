// Zaid backend: one Node process that serves
//   /admin   settings (LiveKit, ElevenLabs, Runway keys), connection tests, integration key, presenter status
//   /studio  production control room (Arabic): rundown, approvals, breaking news, prepare / go live / end
//   /watch   the broadcast for viewers (can be embedded in another site with an iframe)
//   /api/v1  integration API for the newsroom's own backend (x-api-key)
//   /api/public  viewer token + on-air status (no key; for the newsroom's front end)
// and runs the presenter (agent.js) as a child process with the saved keys.
//
// Start:  npm install  &&  npm start        (PORT, DATA_DIR, ADMIN_PASSWORD optional)
import http from 'node:http'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import * as config from './lib/config.js'
import { Store, ApiError, PLAYED } from './lib/store.js'
import { Worker } from './lib/worker.js'
import { TESTS, sampleVoice, livekitHttp } from './lib/checks.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8795)
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex')
const SESSION_HOURS = 12

config.load()
const firstPassword = config.ensurePassword()
const store = new Store(config.DATA_DIR)

// ---------------------------------------------------------------- presenter process
function workerEnv () {
  if (!config.ready.livekit()) return null
  const e = { ...process.env }
  for (const f of config.FIELDS) {
    const v = config.get(f.key)
    if (v) e[f.key] = v; else delete e[f.key]
  }
  for (const k of ['ZAID_VOICE_ID', 'RUNWAY_PRESET_ID', 'ADMIN_PASSWORD']) delete e[k]
  Object.assign(e, {
    RUNWAY_AVATAR_TYPE: config.get('RUNWAY_AVATAR_TYPE'),
    ZAID_AGENT_NAME: config.get('AGENT_NAME'),
    ZAID_LANGUAGE: config.get('LANGUAGE'),
    ZAID_PRESENTER_NAME: config.get('PRESENTER_NAME'),
    ZAID_INTERNAL_URL: `http://127.0.0.1:${PORT}`,
    ZAID_INTERNAL_TOKEN: INTERNAL_TOKEN
  })
  return e
}
const worker = new Worker({ script: path.join(dir, 'agent.js'), cwd: dir, env: workerEnv })
let restartAfterBroadcast = false
const broadcastRunning = () => ['preparing', 'ready', 'live'].includes(store.control().state)
store.on('change', () => {
  if (restartAfterBroadcast && !broadcastRunning()) { restartAfterBroadcast = false; worker.restart() }
})

// ---------------------------------------------------------------- helpers
function send (res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readJson (req, limit = 256 * 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new ApiError(413, 'request body too large')
    chunks.push(c)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError(400, 'body must be JSON') }
}

function cookies (req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))
}

const sessions = new Map() // token -> expiry ms
function isAdmin (req) {
  const t = cookies(req).zaid_admin
  const exp = t && sessions.get(t)
  if (!exp) return false
  if (exp < Date.now()) { sessions.delete(t); return false }
  return true
}
function hasKey (req, url) {
  const h = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const k = h || url.searchParams.get('key') // ?key= only for EventSource, which cannot set headers
  return !!k && config.safeEqual(k, config.apiKey())
}

const attempts = new Map() // ip -> { n, until }
function loginAllowed (ip) {
  const a = attempts.get(ip)
  if (!a || a.until < Date.now()) return true
  return a.n < 10
}
function loginFailed (ip) {
  const a = attempts.get(ip)
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 10 * 60_000 })
  else a.n++
}

function cors (req, res) {
  const origin = (req.headers.origin || '').replace(/\/$/, '')
  if (origin && config.allowedOrigins().includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    res.setHeader('access-control-allow-headers', 'content-type, x-api-key, authorization')
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }
}

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
const secureCookie = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted

// ---------------------------------------------------------------- LiveKit actions
const lk = () => {
  const url = livekitHttp(config.get('LIVEKIT_URL'))
  return {
    rooms: new RoomServiceClient(url, config.get('LIVEKIT_API_KEY'), config.get('LIVEKIT_API_SECRET')),
    dispatch: new AgentDispatchClient(url, config.get('LIVEKIT_API_KEY'), config.get('LIVEKIT_API_SECRET'))
  }
}
let broadcastNo = 0

async function prepareBroadcast ({ goLive = false } = {}) {
  if (!config.ready.livekit()) throw new ApiError(503, 'LiveKit keys are not set (admin page).')
  if (!config.ready.elevenlabs()) throw new ApiError(503, 'ElevenLabs API key or voice ID is not set (admin page).')
  if (worker.state !== 'ready') throw new ApiError(503, `The presenter is not connected to LiveKit yet (${worker.state}${worker.reason ? ': ' + worker.reason : ''}).`)
  if (broadcastRunning()) throw new ApiError(409, `A broadcast is already running (${store.control().state}). End it first.`)
  const room = config.get('ROOM_NAME')
  const { rooms, dispatch } = lk()
  // "preparing" first: the presenter checks it before joining (see agent.js).
  store.setControl('preparing', null, 'presenter joining the studio')
  store.setAutoLive(goLive)
  broadcastNo++
  try {
    try { await rooms.deleteRoom(room) } catch {} // a fresh room for every broadcast
    await rooms.createRoom({ name: room, emptyTimeout: 600 })
    const d = await dispatch.createDispatch(room, config.get('AGENT_NAME'))
    return { room, dispatchId: d.id, goLive: !!goLive }
  } catch (e) {
    store.setControl('idle', null, 'prepare failed: ' + e.message)
    throw new ApiError(502, 'LiveKit: ' + e.message)
  }
}

function goLive () {
  const c = store.control()
  if (c.state === 'ready') return store.setControl('live', null, 'go live')
  if (c.state === 'preparing') { store.setAutoLive(true); return { ...store.control(), note: 'will go live as soon as the opening audio is ready' } }
  throw new ApiError(409, `Cannot go live from "${c.state}". Prepare the broadcast first.`)
}

function endBroadcast () {
  const c = store.setControl('ended', null, 'ended by operator')
  const no = broadcastNo
  // The presenter closes the room itself; this is a safety net if it never joined.
  setTimeout(() => { if (no === broadcastNo && config.ready.livekit()) lk().rooms.deleteRoom(config.get('ROOM_NAME')).catch(() => {}) }, 20_000)
  return c
}

async function viewerToken () {
  if (!config.ready.livekit()) throw new ApiError(503, 'The broadcast is not set up yet.')
  const at = new AccessToken(config.get('LIVEKIT_API_KEY'), config.get('LIVEKIT_API_SECRET'), {
    identity: 'viewer-' + crypto.randomBytes(5).toString('hex'), ttl: '2h'
  })
  at.addGrant({ room: config.get('ROOM_NAME'), roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false })
  return { url: config.get('LIVEKIT_URL'), token: await at.toJwt(), room: config.get('ROOM_NAME') }
}

function publicStatus () {
  const c = store.control()
  const onAir = c.on_air_id ? store.segment(c.on_air_id) : null
  return { state: c.state, presenterName: config.get('PRESENTER_NAME'), onAir: onAir ? { id: onAir.id, headline: onAir.headline, kind: onAir.kind } : null, face: config.ready.runway() }
}

function status () {
  const segs = store.segments()
  return {
    control: store.control(),
    presenterName: config.get('PRESENTER_NAME'),
    onAir: publicStatus().onAir,
    services: { livekit: config.ready.livekit(), elevenlabs: config.ready.elevenlabs(), runway: config.ready.runway() },
    presenter: worker.status(),
    room: config.get('ROOM_NAME'),
    rundown: {
      total: segs.length,
      approvedWaiting: segs.filter(s => s.status === 'approved' && !PLAYED.has(s.playback_state)).length,
      drafts: segs.filter(s => s.status === 'draft').length
    }
  }
}

// ---------------------------------------------------------------- live events (SSE)
const streams = new Set()
let pushTimer
function pushRundown () {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    const data = `event: rundown\ndata: ${JSON.stringify({ control: store.control(), segments: store.segments(), presenter: worker.status() })}\n\n`
    for (const res of streams) res.write(data)
  }, 80)
}
store.on('change', pushRundown)
store.on('log', entry => { const d = `event: log\ndata: ${JSON.stringify(entry)}\n\n`; for (const res of streams) res.write(d) })
setInterval(() => { for (const res of streams) res.write(': ping\n\n') }, 25_000)

// ---------------------------------------------------------------- webhook relay
// Every log event is also POSTed to WEBHOOK_URL (if set), signed with HMAC-SHA256, so another system
// (your backend, a Supabase Edge Function, a queue) can relay it to its own real-time channel.
const webhookStats = { sent: 0, failed: 0, last: null }
const WEBHOOK_OK = /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/
async function sendWebhook (entry, url = config.get('WEBHOOK_URL')) {
  if (!url) return null
  const seg = entry.segment_id ? store.segment(entry.segment_id) : null
  const body = JSON.stringify({
    event: entry.event,
    at: entry.at,
    detail: entry.detail,
    segment: seg ? { id: seg.id, external_id: seg.external_id, headline: seg.headline, kind: seg.kind, status: seg.status, version: seg.version, playback_state: seg.playback_state } : null,
    control: store.control()
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', config.webhookSecret()).update(body).digest('hex')
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zaid-event': entry.event, 'x-zaid-signature': sig },
      body,
      signal: AbortSignal.timeout(5000)
    })
    webhookStats.sent++
    if (!r.ok) webhookStats.failed++
    webhookStats.last = { at: new Date().toISOString(), event: entry.event, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    webhookStats.failed++
    webhookStats.last = { at: new Date().toISOString(), event: entry.event, error: e.message }
  }
  return webhookStats.last
}
store.on('log', entry => { sendWebhook(entry) })
let lastWorkerState = ''
setInterval(() => { const s = worker.status().state; if (s !== lastWorkerState) { lastWorkerState = s; pushRundown() } }, 1000)

function openStream (req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write(`event: rundown\ndata: ${JSON.stringify({ control: store.control(), segments: store.segments(), presenter: worker.status() })}\n\n`)
  streams.add(res)
  req.on('close', () => streams.delete(res))
}

// ---------------------------------------------------------------- integration API (/api/v1)
async function api (req, res, url, parts) {
  const m = req.method
  const [a, b, c] = parts
  const body = ['POST', 'PATCH', 'PUT'].includes(m) ? await readJson(req) : {}
  if (m === 'GET' && a === 'status') return send(res, 200, status())
  if (m === 'GET' && a === 'events') return openStream(req, res)
  if (m === 'GET' && a === 'log') return send(res, 200, store.logs(Math.min(500, Number(url.searchParams.get('limit')) || 60)))

  if (a === 'segments') {
    if (!b && m === 'GET') {
      const ext = url.searchParams.get('externalId')
      return send(res, 200, store.segments().filter(s => !ext || s.external_id === ext))
    }
    if (!b && m === 'POST') {
      const seg = store.create({ ...body, status: body.status || (body.approved ? 'approved' : 'draft') })
      return send(res, 201, seg)
    }
    if (b && !c && m === 'GET') { const s = store.segment(b); return s ? send(res, 200, s) : send(res, 404, { error: `segment ${b} not found` }) }
    if (b && !c && m === 'PATCH') return send(res, 200, store.update(b, body))
    if (b && !c && m === 'DELETE') { store.remove(b); return send(res, 204) }
    if (b && c === 'approve' && m === 'POST') return send(res, 200, store.setStatus(b, 'approved'))
    if (b && c === 'withdraw' && m === 'POST') return send(res, 200, store.setStatus(b, 'withdrawn'))
  }
  if (a === 'breaking' && m === 'POST') {
    const seg = store.create({ ...body, kind: 'breaking', status: 'approved', position: body.position ?? (store.segments().reduce((x, s) => Math.max(x, s.position), 0) + 10) })
    return send(res, 201, { ...seg, note: broadcastRunning() ? 'Zaid will read it right after the segment on air.' : 'Added to the rundown.' })
  }
  if (a === 'rundown' && b === 'clear' && m === 'POST') { store.clear(); return send(res, 200, { ok: true }) }
  if (a === 'rundown' && b === 'demo' && m === 'POST') { if (broadcastRunning()) throw new ApiError(409, 'End the broadcast first.'); store.demo(); return send(res, 200, { ok: true, segments: store.segments() }) }
  if (a === 'broadcast' && m === 'POST') {
    if (b === 'prepare') return send(res, 200, await prepareBroadcast({ goLive: !!body.goLive }))
    if (b === 'start') return send(res, 200, await prepareBroadcast({ goLive: true }))
    if (b === 'live') return send(res, 200, goLive())
    if (b === 'end') return send(res, 200, endBroadcast())
  }
  return send(res, 404, { error: 'unknown endpoint' })
}

// ---------------------------------------------------------------- admin API (/admin/api)
async function admin (req, res, url, parts) {
  const m = req.method
  const [a, b] = parts
  const ip = req.socket.remoteAddress
  if (a === 'login' && m === 'POST') {
    if (!loginAllowed(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' })
    const { password } = await readJson(req, 4096)
    if (!config.checkPassword(password)) { loginFailed(ip); return send(res, 401, { error: 'Wrong password.' }) }
    attempts.delete(ip)
    const t = crypto.randomBytes(32).toString('base64url')
    sessions.set(t, Date.now() + SESSION_HOURS * 3600_000)
    return send(res, 200, { ok: true }, { 'set-cookie': `zaid_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secureCookie(req) ? '; Secure' : ''}` })
  }
  if (!isAdmin(req)) return send(res, 401, { error: 'login required' })
  if (a === 'logout' && m === 'POST') {
    sessions.delete(cookies(req).zaid_admin)
    return send(res, 200, { ok: true }, { 'set-cookie': 'zaid_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' })
  }
  if (a === 'settings' && m === 'GET') {
    return send(res, 200, { ...config.describe(), apiKey: config.apiKey(), webhookSecret: config.webhookSecret(), webhook: webhookStats, presenter: worker.status(), status: status(), restartPending: restartAfterBroadcast, firstPasswordFile: firstPassword ? 'data/admin-password.txt' : null })
  }
  if (a === 'settings' && m === 'PUT') {
    const changed = config.save(await readJson(req))
    const needsRestart = ['livekit', 'elevenlabs', 'runway', 'worker'].some(g => changed.has(g))
    let presenter = 'unchanged'
    if (needsRestart) {
      if (broadcastRunning()) { restartAfterBroadcast = true; presenter = 'restarts after the current broadcast' } else { worker.restart(); presenter = 'restarting with the new keys' }
    }
    pushRundown()
    return send(res, 200, { ok: true, changed: [...changed], presenter, ...config.describe() })
  }
  if (a === 'test' && m === 'POST' && TESTS[b]) {
    const { values = {} } = await readJson(req)
    try { return send(res, 200, await TESTS[b](config.merged(values))) } catch (e) { return send(res, 200, { ok: false, message: e.message }) }
  }
  if (a === 'sample' && m === 'POST') {
    const { values = {}, text } = await readJson(req)
    const t = typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : undefined
    try {
      const s = await sampleVoice(config.merged(values), t)
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-prepare-ms': String(s.prepareMs) })
      return res.end(s.wav)
    } catch (e) { return send(res, 400, { error: e.message }) }
  }
  if (a === 'api-key' && m === 'POST') return send(res, 200, { apiKey: config.rotateApiKey() })
  if (a === 'webhook-secret' && m === 'POST') return send(res, 200, { webhookSecret: config.rotateWebhookSecret() })
  if (a === 'webhook' && b === 'test' && m === 'POST') {
    const { url } = await readJson(req, 4096)
    const target = (typeof url === 'string' && url.trim()) || config.get('WEBHOOK_URL')
    if (!target) return send(res, 400, { error: 'Enter a webhook URL first.' })
    if (!WEBHOOK_OK.test(target)) return send(res, 400, { error: 'The URL must start with https:// (http:// only for localhost).' })
    return send(res, 200, await sendWebhook({ event: 'test', at: new Date().toISOString(), segment_id: null, detail: { note: 'test from the admin page' } }, target))
  }
  if (a === 'password' && m === 'POST') {
    const { current, next } = await readJson(req, 4096)
    if (!config.checkPassword(current)) return send(res, 401, { error: 'The current password is wrong.' })
    if (typeof next !== 'string' || next.length < 10) return send(res, 400, { error: 'Use at least 10 characters.' })
    config.setPassword(next)
    return send(res, 200, { ok: true, note: process.env.ADMIN_PASSWORD ? 'Saved. ADMIN_PASSWORD in the environment also still works.' : 'Saved.' })
  }
  if (a === 'worker' && b === 'restart' && m === 'POST') {
    if (broadcastRunning()) return send(res, 409, { error: 'A broadcast is running. End it first.' })
    worker.restart()
    return send(res, 200, worker.status())
  }
  if (a === 'worker' && b === 'logs' && m === 'GET') return send(res, 200, { status: worker.status(), lines: worker.logs(150) })
  return send(res, 404, { error: 'unknown endpoint' })
}

// ---------------------------------------------------------------- internal API (presenter only)
async function internal (req, res, parts) {
  if (!isLoopback(req) || !config.safeEqual(req.headers['x-internal-token'] || '', INTERNAL_TOKEN)) return send(res, 403, { error: 'forbidden' })
  const m = req.method
  const [a, b] = parts
  if (m === 'GET' && a === 'segments' && !b) return send(res, 200, store.segments())
  if (m === 'GET' && a === 'segments' && b) { const s = store.segment(b); return s ? send(res, 200, s) : send(res, 404, null) }
  if (m === 'GET' && a === 'control') return send(res, 200, store.control())
  const body = await readJson(req)
  if (m === 'POST' && a === 'control') return send(res, 200, store.setControl(body.state, body.onAirId ?? null, body.note ?? null))
  if (m === 'POST' && a === 'playback') return send(res, 200, store.playback(body.id, body.state, body))
  if (m === 'POST' && a === 'log') return send(res, 200, store.log(String(body.event).slice(0, 60), { detail: body.detail || {} }))
  return send(res, 404, { error: 'unknown endpoint' })
}

// ---------------------------------------------------------------- pages
const PAGES = { '/admin': 'console.html', '/studio': 'console.html', '/watch': 'watch.html' }
async function page (req, res, pathname) {
  const frame = pathname === '/watch' ? `'self' ${config.allowedOrigins().join(' ')}`.trim() : "'none'"
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `frame-ancestors ${frame}`,
    'referrer-policy': 'no-referrer'
  })
  res.end(await readFile(path.join(dir, 'public', PAGES[pathname])))
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local')
  const p = url.pathname.replace(/\/+$/, '') || '/'
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    if (p === '/') { res.writeHead(302, { location: '/watch' }); return res.end() }
    if (req.method === 'GET' && PAGES[p]) return await page(req, res, p)
    if (p === '/health') return send(res, 200, { ok: true })

    if (p.startsWith('/api/')) {
      cors(req, res)
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    }
    if (p === '/api/public/viewer-token' && req.method === 'GET') return send(res, 200, await viewerToken())
    if (p === '/api/public/status' && req.method === 'GET') return send(res, 200, publicStatus())

    if (p.startsWith('/api/v1/')) {
      if (!hasKey(req, url) && !isAdmin(req)) return send(res, 401, { error: 'missing or wrong x-api-key' })
      return await api(req, res, url, p.slice('/api/v1/'.length).split('/'))
    }
    if (p.startsWith('/admin/api/')) return await admin(req, res, url, p.slice('/admin/api/'.length).split('/'))
    if (p.startsWith('/internal/')) return await internal(req, res, p.slice('/internal/'.length).split('/'))
    send(res, 404, { error: 'not found' })
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(e)
    if (!res.headersSent) send(res, e.status || 500, { error: e.message })
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`Zaid backend on http://localhost:${PORT}`)
  console.log(`  admin  http://localhost:${PORT}/admin   studio /studio   watch /watch   API /api/v1`)
  if (firstPassword) console.log(`  First start: admin password = ${firstPassword}  (also saved in ${path.join(config.DATA_DIR, 'admin-password.txt')}; change it on the admin page)`)
  worker.start()
})

async function shutdown () {
  await worker.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
