// Zaid, the on-air presenter: a LiveKit Agent. Started by server.js (do not run it by hand).
// - Voice: ElevenLabs eleven_v4_turbo audio, prepared ahead for each approved segment version.
// - Face: a Runway Character when its keys are set; Runway lip-syncs to the audio Zaid speaks.
//   If Runway fails (no credits, wrong ID) the broadcast continues with voice only and the error is logged.
// - Text: session.say(script, { audio }) plays the approved text word for word. No LLM reads the news.
import { fileURLToPath } from 'node:url'
import { cli, defineAgent, ServerOptions, voice } from '@livekit/agents'
import * as runway from '@livekit/agents-plugin-runway'
import { AudioFrame } from '@livekit/rtc-node'
import { db, env } from './lib/link.js'
import { Rundown } from './lib/rundown.js'
import { SAMPLE_RATE } from './lib/tts.js'

function pcmStream (pcm) {
  const perFrame = SAMPLE_RATE / 10 // 100 ms frames
  let i = 0
  return new ReadableStream({
    pull (controller) {
      if (i >= pcm.length) return controller.close()
      const n = Math.min(perFrame, pcm.length - i)
      controller.enqueue(new AudioFrame(pcm.slice(i, i + n), SAMPLE_RATE, 1, n))
      i += n
    }
  })
}

export default defineAgent({
  entry: async (ctx) => {
    const log = (...a) => console.log('[zaid]', ...a)
    // Only present when this server asked for it. LiveKit can hand a leftover job from an old room
    // (or from another server using the same agent name) to this worker; such a job leaves at once.
    const control = await db.control()
    if (control?.state !== 'preparing') {
      log(`job for room ${ctx.job.room?.name} not requested by this server (studio is "${control?.state}"), leaving`)
      db.log('job_refused', { room: ctx.job.room?.name, studio: control?.state }).catch(() => {})
      ctx.shutdown('not requested')
      return
    }
    await ctx.connect()
    const session = new voice.AgentSession({})

    let avatar = null
    if (env.runwaySecret && env.runwayAvatar) {
      try {
        avatar = new runway.AvatarSession({
          ...(env.runwayAvatarType === 'preset' ? { presetId: env.runwayAvatar } : { avatarId: env.runwayAvatar }),
          apiKey: env.runwaySecret,
          maxDuration: 1800,
          avatarParticipantName: 'زيد'
        })
        await avatar.start(session, ctx.room)
        log('Runway character started')
        db.log('runway_started', { avatar: env.runwayAvatar }).catch(() => {})
      } catch (e) {
        avatar = null
        log('Runway failed, continuing with voice only:', e.message)
        db.log('runway_failed', { error: String(e.message || e).slice(0, 500) }).catch(() => {})
      }
    } else {
      db.log('voice_only', { reason: 'Runway keys not set' }).catch(() => {})
    }

    await session.start({
      agent: new voice.Agent({ instructions: 'You are Zaid, an Arabic news presenter. You only read approved segments.' }),
      room: ctx.room,
      // Zaid presents; he does not listen. Viewers joining or leaving must not end the broadcast.
      inputOptions: { audioEnabled: false, textEnabled: false, closeOnDisconnect: false },
      record: false
    })

    const publish = event => {
      ctx.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(event)), { reliable: true, topic: 'zaid' })
        .catch(e => log('publishData failed', e.message))
    }

    const rundown = new Rundown({
      log,
      publish,
      speak: async (segment, prepared) => {
        const handle = session.say(segment.script, { audio: pcmStream(prepared.pcm), allowInterruptions: false, addToChatCtx: false })
        await handle.waitForPlayout()
      }
    })

    ctx.addShutdownCallback(async () => { rundown.stop() })
    try {
      await rundown.prepareStudio()
      await rundown.run()
    } catch (e) {
      log('broadcast failed', e.message)
      await db.setControl('ended', null, 'failed: ' + String(e.message || e).slice(0, 300)).catch(() => {})
    }

    // End explicitly: close the avatar and the session, then leave the room.
    try { await avatar?.aclose() } catch (e) { log('avatar close', e.message) }
    await session.close()
    ctx.shutdown('broadcast ended')
  }
})

// initializeProcessTimeout: 10 s (the default) was too short on a busy PC; one warm process is enough.
cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: env.agentName,
  initializeProcessTimeout: 60_000,
  numIdleProcesses: 1
}))
