// Runs the presenter (agent.js, a LiveKit Agents worker) as a child process of the web server,
// with the keys from the admin page. Saving new keys restarts it; if it crashes it is restarted.
import { spawn, execFile } from 'node:child_process'

const NOISE = /event loop blocked|process not scheduled|dev mode is deprecated/
const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }

export class Worker {
  constructor ({ script, cwd, env }) {
    this.script = script; this.cwd = cwd; this.envFn = env
    this.state = 'stopped' // waiting | starting | ready | stopped | crashed
    this.reason = ''
    this.lines = []
    this.since = new Date().toISOString()
    this.failures = 0
  }

  status () { return { state: this.state, reason: this.reason, since: this.since, pid: this.child?.pid || null } }
  logs (n = 80) { return this.lines.slice(-n) }

  #set (state, reason = '') { this.state = state; this.reason = reason; this.since = new Date().toISOString() }

  #line (raw) {
    const text = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (!text || NOISE.test(text)) return
    let out = text
    try {
      const j = JSON.parse(text)
      if (j.msg && NOISE.test(j.msg)) return
      const t = j.time ? new Date(j.time).toISOString().slice(11, 19) : ''
      const err = j.err?.message || j.error?.message || j.error || ''
      out = `${t} ${LEVELS[j.level] || ''} ${j.msg || ''}${err ? ' — ' + (typeof err === 'string' ? err : JSON.stringify(err)) : ''}`.trim()
      if (j.msg === 'registered worker') { this.#set('ready'); this.failures = 0 }
    } catch {
      if (/registered worker/.test(text)) { this.#set('ready'); this.failures = 0 }
    }
    this.lines.push(out)
    if (this.lines.length > 400) this.lines.splice(0, 100)
  }

  start () {
    if (this.child) return
    const env = this.envFn()
    if (!env) { this.#set('waiting', 'Fill and save the LiveKit keys to start the presenter.'); return }
    this.stopping = false
    this.#set('starting')
    const child = spawn(process.execPath, [this.script, 'start'], { cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    for (const stream of [child.stdout, child.stderr]) {
      let buf = ''
      stream.on('data', d => {
        buf += d.toString()
        const parts = buf.split(/\r?\n/)
        buf = parts.pop()
        parts.forEach(l => this.#line(l))
      })
    }
    child.on('exit', code => {
      this.child = null
      if (this.stopping) { this.#set('stopped'); return }
      this.failures++
      const wait = Math.min(60, 5 * this.failures)
      this.#set('crashed', `exited with code ${code}; restarting in ${wait} s`)
      this.restartTimer = setTimeout(() => this.start(), wait * 1000)
    })
  }

  async stop () {
    clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) { if (this.state !== 'waiting') this.#set('stopped'); return }
    this.stopping = true
    const exited = new Promise(resolve => child.once('exit', resolve))
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    else child.kill('SIGINT')
    const t = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL') } catch {} }, 8000)
    await exited
    clearTimeout(t)
  }

  async restart () {
    await this.stop()
    this.failures = 0
    this.start()
  }
}
