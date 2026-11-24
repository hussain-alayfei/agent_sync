// The live rundown: the production director's rules plus the playback loop.
// It does not know about LiveKit: it is given a `speak(segment, prepared)` function that resolves
// when the segment has finished playing, and a `publish(event)` function for on-screen data.
// That keeps it testable without a room (see dry-run.js).
import { db, env } from './link.js'
import { prepareAudio } from './tts.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PLAYED = new Set(['done', 'blocked', 'on_air'])

// ---------- director rules (deterministic for now; an LLM director can replace `place`) ----------
// A breaking segment that gets approved while live goes right after the segment on air,
// so Zaid finishes his current sentence block and then takes it at the next boundary.
export function place (segments, onAir) {
  const moves = []
  if (!onAir) return moves
  const upcoming = segments.filter(s => !PLAYED.has(s.playback_state) && s.position > onAir.position)
  for (const s of segments) {
    if (s.kind !== 'breaking' || s.status !== 'approved' || PLAYED.has(s.playback_state)) continue
    const nextNormal = upcoming.filter(u => u.kind !== 'breaking').sort((a, b) => a.position - b.position)[0]
    const target = nextNormal ? (onAir.position + nextNormal.position) / 2 : onAir.position + 1
    const alreadyNext = !upcoming.some(u => u.id !== s.id && u.position < s.position && u.kind !== 'breaking')
    if (s.position <= onAir.position || !alreadyNext) moves.push({ id: s.id, position: target })
  }
  return moves
}

export function nextSegment (segments) {
  return segments
    .filter(s => s.status === 'approved' && !PLAYED.has(s.playback_state))
    .sort((a, b) => a.position - b.position)[0]
}

// ---------- the studio ----------
export class Rundown {
  constructor ({ speak, publish = () => {}, log = console.log, lookAhead = 2 }) {
    this.speak = speak; this.publish = publish; this.log = log; this.lookAhead = lookAhead
    this.cache = new Map() // id -> { version, pcm, audioMs, prepareMs }
    this.preparing = new Map() // `${id}@${version}` -> Promise
    this.onAir = null
    this.stopped = false
  }

  key (s) { return `${s.id}@${s.version}` }

  // Prepare the next approved segments' audio in the background (the "Next ready" column).
  async prepareAhead (segments) {
    const upcoming = segments
      .filter(s => s.status === 'approved' && !PLAYED.has(s.playback_state))
      .sort((a, b) => a.position - b.position)
      .slice(0, this.lookAhead)
    for (const s of upcoming) this.ensurePrepared(s).catch(e => this.log('prepare failed', s.id, e.message))
  }

  ensurePrepared (s) {
    const have = this.cache.get(s.id)
    if (have && have.version === s.version) return Promise.resolve(have)
    const k = this.key(s)
    if (this.preparing.has(k)) return this.preparing.get(k)
    const p = (async () => {
      await db.playback(s.id, 'preparing', { version: s.version })
      const a = await prepareAudio(s.script, { apiKey: env.elevenKey, voiceId: env.voiceId, language: env.language })
      const item = { version: s.version, ...a }
      this.cache.set(s.id, item)
      const now = await db.segment(s.id)
      // Only mark ready if nothing changed while we were generating.
      if (now && now.version === s.version && !PLAYED.has(now.playback_state)) {
        await db.playback(s.id, 'ready', { version: s.version, audioMs: a.audioMs, prepareMs: a.prepareMs })
      }
      this.log(`prepared #${s.id} v${s.version}: ${a.audioMs} ms of audio in ${a.prepareMs} ms`)
      return item
    })().finally(() => this.preparing.delete(k))
    this.preparing.set(k, p)
    return p
  }

  // Housekeeping every tick: block withdrawn segments, let the director place breaking news, prepare ahead.
  async tick () {
    let segments = await db.segments()
    for (const s of segments) {
      if (s.status === 'withdrawn' && !PLAYED.has(s.playback_state)) {
        await db.playback(s.id, 'blocked', { version: s.version, detail: { reason: 'withdrawn' } })
        this.cache.delete(s.id)
        this.log(`blocked #${s.id} (withdrawn)`)
      }
    }
    for (const m of place(segments, this.onAir)) {
      await db.playback(m.id, 'queued', { position: m.position, detail: { director: 'insert after on-air segment' } })
      this.log(`director: breaking #${m.id} goes next (position ${m.position})`)
    }
    segments = await db.segments()
    await this.prepareAhead(segments)
    return segments
  }

  // Before "go live": prepare the opening segments.
  async prepareStudio () {
    await db.setControl('preparing', null, 'preparing opening audio')
    const segments = await db.segments()
    const first = segments.filter(s => s.status === 'approved' && !PLAYED.has(s.playback_state))
      .sort((a, b) => a.position - b.position).slice(0, this.lookAhead)
    await Promise.all(first.map(s => this.ensurePrepared(s)))
    await db.setControl('ready', null, 'opening ready')
  }

  async waitForLive () {
    for (;;) {
      if (this.stopped) return false
      const c = await db.control()
      if (c.state === 'live') return true
      if (c.state === 'ended') return false
      await this.tick()
      await sleep(1000)
    }
  }

  // The director works in the background while Zaid speaks: it blocks withdrawn segments,
  // places breaking news and prepares the next audio, so a boundary costs one check only.
  startBackground () {
    this.bgRunning = true
    ;(async () => {
      while (this.bgRunning) {
        try {
          this.latest = await this.tick()
          this.ended = (await db.control()).state === 'ended'
        } catch (e) { this.log('director tick failed', e.message) }
        await sleep(800)
      }
    })()
  }

  // Main loop: play segments at boundaries until the operator ends the broadcast.
  async run () {
    if (!(await this.waitForLive())) return this.log('ended before going live')
    this.log('LIVE')
    this.latest = await this.tick()
    this.startBackground()
    for (;;) {
      if (this.stopped || this.ended) break
      const s = nextSegment(this.latest || [])
      if (!s) { await sleep(300); continue }

      let prepared = await this.ensurePrepared(s)
      // Last check at the boundary: still approved, still the same version?
      const fresh = await db.segment(s.id)
      if (!fresh || fresh.status !== 'approved') {
        if (fresh?.status === 'withdrawn') await db.playback(s.id, 'blocked', { version: s.version, detail: { reason: 'withdrawn at boundary' } })
        this.latest = await db.segments()
        continue
      }
      if (fresh.version !== prepared.version) { prepared = await this.ensurePrepared(fresh) }

      this.onAir = fresh
      this.publish({ type: 'segment', id: fresh.id, kind: fresh.kind, headline: fresh.headline, script: fresh.script })
      const t0 = Date.now()
      // Start speaking at once; record "on air" in parallel.
      const marks = Promise.all([db.playback(fresh.id, 'on_air', { version: fresh.version }), db.setControl('live', fresh.id)])
      await this.speak(fresh, prepared)
      const playedMs = Date.now() - t0
      // Record "done" without holding up the next segment.
      marks.then(() => db.playback(fresh.id, 'done', { version: fresh.version, detail: { played_ms: playedMs } }))
        .catch(e => this.log('log done failed', e.message))
      this.cache.delete(fresh.id)
      this.log(`played #${fresh.id} v${fresh.version} in ${playedMs} ms`)
      // Mark it done locally too, so the next pick doesn't wait for the background refresh.
      this.latest = (this.latest || []).map(x => x.id === fresh.id ? { ...x, playback_state: 'done' } : x)
      await sleep(150) // short breath between segments
    }
    this.bgRunning = false
    this.publish({ type: 'end' })
    await db.setControl('ended', null, 'broadcast ended')
    this.log('ENDED')
  }

  stop () { this.stopped = true }
}
