// The rundown: segments (versioned), the studio control state and a log, kept in DATA_DIR/state.json.
// Rules (same as the proof of concept):
//  - a script change makes a new version and puts the segment back to draft (it must be approved again);
//  - only approved segments are read; a withdrawn segment is blocked by the presenter at the boundary;
//  - a segment that is on air or already played cannot be edited.
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const PLAYED = new Set(['done', 'blocked', 'on_air'])
const PLAYBACK = new Set(['queued', 'preparing', 'ready', 'on_air', 'done', 'blocked'])
const CONTROL = new Set(['idle', 'preparing', 'ready', 'live', 'ended'])
const MAX_SCRIPT = 3000
const MAX_HEADLINE = 200

const DEMO = [
  ['افتتاح النشرة', 'مساء الخير، وأهلاً بكم في نشرة الأخبار. معكم زيد، وإليكم أبرز ما في هذه النشرة.'],
  ['جلسة حكومية استثنائية', 'تعقد الحكومة اليوم جلسة استثنائية لبحث الأوضاع الاقتصادية، وسط مطالب بإجراءات عاجلة لدعم القطاعات المتضررة.'],
  ['خطة الكهرباء للشتاء', 'أعلنت وزارة الطاقة عن خطة جديدة لزيادة ساعات التغذية الكهربائية خلال فصل الشتاء، تبدأ مطلع الشهر المقبل.']
]

export class ApiError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

const now = () => new Date().toISOString()

export class Store extends EventEmitter {
  constructor (dir) {
    super()
    this.file = path.join(dir, 'state.json')
    this.s = { nextId: 1, nextLogId: 1, segments: [], control: { state: 'idle', on_air_id: null, note: '', auto_live: false, updated_at: now() }, log: [] }
    try { Object.assign(this.s, JSON.parse(fs.readFileSync(this.file, 'utf8'))) } catch {}
    // A broadcast does not survive a server restart (the presenter process is gone).
    if (['preparing', 'ready', 'live'].includes(this.s.control.state)) {
      Object.assign(this.s.control, { state: 'ended', on_air_id: null, auto_live: false, note: 'server restarted' })
    }
    for (const seg of this.s.segments) {
      if (seg.playback_state === 'on_air') seg.playback_state = 'done'
      if (['preparing', 'ready'].includes(seg.playback_state)) seg.playback_state = 'queued'
    }
  }

  changed () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.s))
      fs.renameSync(tmp, this.file)
    }, 150)
    this.emit('change')
  }

  log (event, { segment_id = null, version = null, detail = {} } = {}) {
    const entry = { id: this.s.nextLogId++, segment_id, version, event, detail, at: now() }
    this.s.log.push(entry)
    if (this.s.log.length > 500) this.s.log.splice(0, this.s.log.length - 500)
    this.emit('log', entry)
    return entry
  }

  logs (limit = 60) { return this.s.log.slice(-limit).reverse() }
  control () { return { ...this.s.control } }
  segments () { return [...this.s.segments].sort((a, b) => a.position - b.position).map(s => ({ ...s })) }
  segment (id) {
    const s = this.s.segments.find(x => x.id === Number(id))
    return s ? { ...s } : null
  }

  #get (id) {
    const s = this.s.segments.find(x => x.id === Number(id))
    if (!s) throw new ApiError(404, `segment ${id} not found`)
    return s
  }

  #text (v, max, name, required) {
    if (v === undefined || v === null) {
      if (required) throw new ApiError(400, `${name} is required`)
      return undefined
    }
    const t = String(v).trim()
    if (required && !t) throw new ApiError(400, `${name} is required`)
    if (t.length > max) throw new ApiError(400, `${name} is longer than ${max} characters`)
    return t
  }

  create ({ headline, script, kind = 'normal', position, status = 'draft', externalId } = {}) {
    script = this.#text(script, MAX_SCRIPT, 'script', true)
    headline = this.#text(headline, MAX_HEADLINE, 'headline', false) || ''
    if (!['normal', 'breaking'].includes(kind)) throw new ApiError(400, 'kind must be normal or breaking')
    if (!['draft', 'approved'].includes(status)) throw new ApiError(400, 'status must be draft or approved')
    if (position !== undefined && position !== null && !Number.isFinite(Number(position))) throw new ApiError(400, 'position must be a number')
    const max = this.s.segments.reduce((m, s) => Math.max(m, s.position), 0)
    const seg = {
      id: this.s.nextId++, external_id: externalId ? String(externalId).slice(0, 200) : null,
      headline, script, version: 1, status, kind,
      position: position !== undefined && position !== null ? Number(position) : max + 10,
      playback_state: 'queued', prepared_version: null, audio_ms: null, prepare_ms: null,
      created_at: now(), updated_at: now()
    }
    this.s.segments.push(seg)
    this.log('created', { segment_id: seg.id, version: 1, detail: { kind, status } })
    this.changed()
    return { ...seg }
  }

  update (id, { headline, script, position, status } = {}) {
    const seg = this.#get(id)
    if (PLAYED.has(seg.playback_state)) throw new ApiError(409, `segment ${seg.id} is ${seg.playback_state} and cannot be edited`)
    headline = this.#text(headline, MAX_HEADLINE, 'headline', false)
    script = this.#text(script, MAX_SCRIPT, 'script', false)
    if (script === '') throw new ApiError(400, 'script cannot be empty')
    if (headline !== undefined) seg.headline = headline
    if (script !== undefined && script !== seg.script) {
      seg.script = script
      seg.version += 1
      seg.status = 'draft'
      if (['ready', 'preparing'].includes(seg.playback_state)) seg.playback_state = 'queued'
    }
    if (position !== undefined && position !== null) {
      if (!Number.isFinite(Number(position))) throw new ApiError(400, 'position must be a number')
      seg.position = Number(position)
    }
    seg.updated_at = now()
    this.log('edited', { segment_id: seg.id, version: seg.version })
    if (status) return this.setStatus(seg.id, status)
    this.changed()
    return { ...seg }
  }

  setStatus (id, status) {
    if (!['draft', 'approved', 'withdrawn'].includes(status)) throw new ApiError(400, 'status must be draft, approved or withdrawn')
    const seg = this.#get(id)
    if (PLAYED.has(seg.playback_state)) throw new ApiError(409, `segment ${seg.id} is ${seg.playback_state}`)
    seg.status = status
    seg.updated_at = now()
    this.log(status, { segment_id: seg.id, version: seg.version })
    this.changed()
    return { ...seg }
  }

  remove (id) {
    const seg = this.#get(id)
    if (seg.playback_state === 'on_air') throw new ApiError(409, `segment ${seg.id} is on air`)
    this.s.segments = this.s.segments.filter(s => s !== seg)
    this.log('deleted', { segment_id: seg.id, version: seg.version })
    this.changed()
  }

  // Called by the presenter process.
  playback (id, state, { version, audioMs, prepareMs, position, detail } = {}) {
    if (!PLAYBACK.has(state)) throw new ApiError(400, 'bad playback state')
    const seg = this.s.segments.find(x => x.id === Number(id))
    if (!seg) return null
    seg.playback_state = state
    if (version != null) seg.prepared_version = version
    if (audioMs != null) seg.audio_ms = audioMs
    if (prepareMs != null) seg.prepare_ms = prepareMs
    if (position != null) seg.position = Number(position)
    seg.updated_at = now()
    this.log(state, { segment_id: seg.id, version: version ?? null, detail: detail || {} })
    this.changed()
    return { ...seg }
  }

  setControl (state, onAirId = null, note = null) {
    if (!CONTROL.has(state)) throw new ApiError(400, 'bad control state')
    const c = this.s.control
    // "Prepare and go live": the presenter reports ready, the studio goes live at once.
    if (state === 'ready' && c.auto_live) { state = 'live'; note = 'live (automatic after prepare)' }
    c.state = state
    c.on_air_id = onAirId
    if (note !== null) c.note = note
    if (state === 'ended' || state === 'idle' || state === 'live') c.auto_live = false
    c.updated_at = now()
    this.log('studio_' + state, { segment_id: onAirId, detail: note ? { note } : {} })
    this.changed()
    return this.control()
  }

  setAutoLive (on) { this.s.control.auto_live = !!on; this.changed() }

  clear () {
    if (this.s.control.state === 'live') throw new ApiError(409, 'end the broadcast before clearing the rundown')
    this.s.segments = []
    Object.assign(this.s.control, { state: 'idle', on_air_id: null, auto_live: false, note: '' })
    this.log('rundown_cleared')
    this.changed()
  }

  demo () {
    this.clear()
    this.s.log = []
    DEMO.forEach(([headline, script], i) => this.create({ headline, script, status: 'approved', position: (i + 1) * 10 }))
    this.log('demo_reset')
    this.changed()
  }
}
