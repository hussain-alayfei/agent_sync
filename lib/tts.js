// ElevenLabs speech, prepared ahead: eleven_v4_turbo over the Text to Dialogue WebSocket
// (the only endpoint that serves v4 Turbo), raw PCM 24 kHz mono 16-bit, ready for LiveKit frames.
export const SAMPLE_RATE = 24000

export function prepareAudio (text, { apiKey, voiceId, language = 'ar', model = 'eleven_v4_turbo', timeoutMs = 30000 } = {}) {
  if (!apiKey || !voiceId) return Promise.reject(new Error('ElevenLabs API key or voice ID is missing'))
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const url = 'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input' +
      `?model_id=${encodeURIComponent(model)}&output_format=pcm_${SAMPLE_RATE}&language_code=${encodeURIComponent(language)}`
    const ws = new WebSocket(url)
    const chunks = []
    let done = false
    const timer = setTimeout(() => finish(new Error('ElevenLabs timeout')), timeoutMs)

    function finish (err) {
      if (done) return
      done = true; clearTimeout(timer)
      try { ws.close() } catch {}
      if (err) return reject(err)
      const buf = Buffer.concat(chunks)
      if (!buf.length) return reject(new Error('ElevenLabs returned no audio (check the API key and the voice ID)'))
      const pcm = new Int16Array(Math.floor(buf.length / 2))
      new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.length * 2))
      resolve({ pcm, audioMs: Math.round(pcm.length / SAMPLE_RATE * 1000), prepareMs: Date.now() - t0 })
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ voices: [voiceId], xi_api_key: apiKey }))
      ws.send(JSON.stringify({ inputs: [{ text, voice_id: voiceId, new_turn: false }] }))
      ws.send(JSON.stringify({ close_socket: true }))
    }
    ws.onmessage = e => {
      let m
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString()) } catch { return }
      if (m.error) {
        const err = m.message ? `${m.error}: ${m.message}` : m.error
        return finish(new Error('ElevenLabs: ' + (typeof err === 'string' ? err : JSON.stringify(err))))
      }
      if (m.audio) chunks.push(Buffer.from(m.audio, 'base64'))
      if (m.is_final) finish()
    }
    ws.onerror = () => finish(new Error('ElevenLabs connection failed'))
    ws.onclose = () => finish()
  })
}

// 16-bit mono PCM → WAV file bytes (for the admin page's voice sample).
export function toWav (pcm, rate = SAMPLE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
