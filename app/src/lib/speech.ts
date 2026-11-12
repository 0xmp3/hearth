// Speaking a reply.
//
// Two jobs, deliberately together because they are the same problem: decide
// where one utterance ends, and play them without gaps.
//
// The manager synthesises faster than real-time (1.6 s for 3.8 s of audio), so
// sentence n+1 is fetched while n is playing. That is what makes long replies
// flow instead of stuttering once per sentence.
//
// Speech is decoration, never a dependency: every failure is swallowed and the
// text stays exactly as it was.

import { manager } from './backend'

/** What is worth reading aloud, and where one utterance ends. */
export function splitSentences(text: string): string[] {
  // Fenced code is unreadable aloud: drop it rather than read punctuation.
  let body = text.replace(/```[\s\S]*?```/g, ' ')
  // Links keep their text, images lose theirs.
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Markdown emphasis and heading marks are noise to a voice.
  body = body.replace(/[*_`#>]+/g, '')
  // Table pipes and rules read as "pipe, dash".
  body = body.replace(/^\s*\|.*\|\s*$/gm, ' ')
  body = body.replace(/^\s*[-=]{3,}\s*$/gm, ' ')
  body = body.replace(/\s+/g, ' ').trim()
  if (!body) return []

  const parts = body.split(/(?<=[.!?…])\s+/)
  const out: string[] = []
  let carry = ''
  for (const part of parts) {
    const piece = (carry ? carry + ' ' : '') + part.trim()
    // Very short fragments ("Yes.", "Right.") sound clipped on their own; glue
    // them to the next sentence so they get prosody from context.
    if (piece.length < 40) {
      carry = piece
      continue
    }
    out.push(piece)
    carry = ''
  }
  if (carry.trim()) out.push(carry.trim())
  // Guard the manager's per-utterance ceiling.
  const capped: string[] = []
  for (const s of out) {
    if (s.length <= 1200) capped.push(s)
    else for (let i = 0; i < s.length; i += 1200) capped.push(s.slice(i, i + 1200))
  }
  return capped
}

type Playback = {
  ctx: AudioContext
  sources: Set<AudioBufferSourceNode>
}

let playback: Playback | null = null
let generation = 0

function context(): Playback {
  if (playback && playback.ctx.state !== 'closed') return playback
  const ctx = new AudioContext()
  playback = { ctx, sources: new Set() }
  return playback
}

async function fetchSpeech(text: string, voice: string, signal: AbortSignal): Promise<AudioBuffer | null> {
  try {
    if (signal.aborted) return null
    const bytes = await manager.speak(text, voice)
    if (!bytes || !bytes.byteLength) return null
    const { ctx } = context()
    return await ctx.decodeAudioData(bytes)
  } catch {
    return null
  }
}

function play(ctx: AudioContext, buffer: AudioBuffer, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const p = context()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    p.sources.add(source)
    const done = () => {
      p.sources.delete(source)
      resolve()
    }
    source.onended = done
    signal.addEventListener('abort', () => {
      try {
        source.stop()
      } catch {}
      done()
    })
    source.start()
  })
}

export type SpeechProgress = {
  /** Index of the sentence being spoken, 0-based. */
  index: number
  total: number
  /** True until the first sentence is audible. */
  starting: boolean
}

/**
 * Speak `text` and resolve when it finishes or is cancelled.
 *
 * `onChange` reports progress so the UI can say "starting" without a spinner
 * that never ends when speech is unavailable.
 */
export async function speak(
  text: string,
  voice: string,
  onChange: (p: SpeechProgress | null) => void,
  stopSignal: AbortSignal,
): Promise<void> {
  const sentences = splitSentences(text)
  if (!sentences.length) return

  const mine = ++generation
  const controller = new AbortController()
  const onStop = () => controller.abort()
  stopSignal.addEventListener('abort', onStop)

  const p = context()
  // A page that has not been clicked yet leaves the context suspended; resuming
  // here is allowed whenever a gesture happened at all, and harmless otherwise.
  void p.ctx.resume().catch(() => {})

  let next: Promise<AudioBuffer | null> | null = fetchSpeech(sentences[0], voice, controller.signal)
  try {
    for (let i = 0; i < sentences.length; i += 1) {
      if (mine !== generation) return
      onChange({ index: i, total: sentences.length, starting: i === 0 })
      const buffer = await next
      if (controller.signal.aborted || mine !== generation) return
      // Start the next one while this plays: synthesis is ~2.4x real-time, so it
      // lands well before the current sentence ends.
      next = i + 1 < sentences.length ? fetchSpeech(sentences[i + 1], voice, controller.signal) : null
      if (!buffer) continue
      onChange({ index: i, total: sentences.length, starting: false })
      await play(p.ctx, buffer, controller.signal)
    }
  } finally {
    stopSignal.removeEventListener('abort', onStop)
    if (mine === generation) onChange(null)
  }
}

/** Stop everything now. New speech supersedes old speech. */
export function stop(): void {
  generation += 1
  if (!playback) return
  for (const source of playback.sources) {
    try {
      source.stop()
    } catch {}
  }
  playback.sources.clear()
}
