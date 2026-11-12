// Speech, the same way everything else in this app works: the manager owns the
// engine, the app just asks.
//
// The engine is llama.cpp itself. `llama-server` can host a TTS model and answer
// `POST /v1/audio/speech`, which is why this module is small: we spawn a second
// server on its own port with the Qwen3-TTS GGUF pair, keep it warm while it is
// being used, and proxy sentences to it.
//
// Two measurements decided this design:
//
//   * the CLI (`llama-tts.exe`) reloads the model on every call — 4.8 s of wall
//     time for 3.7 s of audio, of which 3.4 s was load. Unusable per sentence.
//   * the resident server answers in 1.0–1.7 s for 2.4–3.8 s of audio (2.3–2.6x
//     real-time) because the model is already loaded. Fast enough to speak
//     sentence n while sentence n+1 is being made.
//
// A voice is a **reference clip**, not a name in a list: the server takes
// `speaker_ref_b64` per request, so one warm process can clone any voice in
// `data/voices`. Clips are the user's and are never bundled — we ship an engine,
// not somebody's voice.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { readConfig, resolveEngine, writeConfig } from '../engine/resolve.mjs'

const READY_TIMEOUT_MS = 90_000
const SPEAK_TIMEOUT_MS = 120_000
const MAX_TEXT = 4000
const MAX_VOICE_BYTES = 20 * 1024 * 1024
const AUDIO_EXT = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'opus'])
const DEFAULT_PORT = 8097

const DEFAULTS = {
  enabled: false,
  model: '',
  mmproj: '',
  // ISO 639-1 of the *speech*, not the clip: the model carries the voice across
  // languages, which is the point of a reference clip.
  lang: 'en',
  ngl: 99,
  port: DEFAULT_PORT,
  /** Minutes of silence before the TTS server is stopped again. */
  idleMinutes: 10,
}

export function ttsDir(dataDir) {
  return join(dataDir, 'tts')
}

export function voicesDir(dataDir) {
  return join(ttsDir(dataDir), 'voices')
}

export function cacheDir(dataDir) {
  return join(ttsDir(dataDir), 'cache')
}

export function ttsConfig(dataDir) {
  const cfg = readConfig(dataDir)
  return { ...DEFAULTS, ...(cfg.tts ?? {}) }
}

export function saveTtsConfig(dataDir, patch) {
  const next = { ...DEFAULTS, ...ttsConfig(dataDir) }
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue
    if (key === 'enabled') next.enabled = patch.enabled === true
    else if (key === 'ngl') next.ngl = Math.max(0, Math.min(999, Number(patch.ngl) || 0))
    else if (key === 'port') next.port = Math.max(1024, Math.min(65535, Number(patch.port) || DEFAULT_PORT))
    else if (key === 'idleMinutes') next.idleMinutes = Math.max(0, Math.min(240, Number(patch.idleMinutes) || 0))
    else next[key] = String(patch[key])
  }
  writeConfig(dataDir, { tts: next })
  return next
}

async function fileInfo(path) {
  if (!path) return { path: '', exists: false, bytes: 0 }
  try {
    const s = await stat(path)
    return { path, exists: true, bytes: s.size }
  } catch {
    return { path, exists: false, bytes: 0 }
  }
}

/** Voices are whatever audio files are sitting in data/voices. */
export async function listVoices(dataDir) {
  const dir = voicesDir(dataDir)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = extname(entry.name).slice(1).toLowerCase()
      if (!AUDIO_EXT.has(ext)) continue
      const s = await stat(join(dir, entry.name))
      const id = entry.name.slice(0, -(ext.length + 1))
      out.push({ id, name: id, file: entry.name, ext, bytes: s.size })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

async function voiceFile(dataDir, id) {
  if (!id) return null
  const hit = (await listVoices(dataDir)).find((v) => v.id === id)
  return hit ? join(voicesDir(dataDir), hit.file) : null
}

/**
 * Import a clip. Base64 rather than multipart: there is no multipart parser
 * here, and one 20 MB clip does not justify adding one.
 */
export async function importVoice(dataDir, { name, ext, data }) {
  const cleanExt = String(ext ?? '').replace(/^\./, '').toLowerCase()
  if (!AUDIO_EXT.has(cleanExt)) throw new Error(`unsupported audio type: ${ext ?? 'none'}`)
  const buf = Buffer.from(String(data ?? ''), 'base64')
  if (!buf.length) throw new Error('empty file')
  if (buf.length > MAX_VOICE_BYTES) throw new Error('clip is larger than 20 MB')

  const safe =
    String(name ?? 'voice')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'voice'

  let id = safe
  const existing = new Set((await listVoices(dataDir)).map((v) => v.id))
  for (let n = 2; existing.has(id); n += 1) id = `${safe}-${n}`

  await mkdir(voicesDir(dataDir), { recursive: true })
  await writeFile(join(voicesDir(dataDir), `${id}.${cleanExt}`), buf)
  return { id, name: id, bytes: buf.length }
}

export async function removeVoice(dataDir, id) {
  const path = await voiceFile(dataDir, id)
  if (!path) throw new Error('no such voice')
  await rm(path, { force: true })
}

// ---- the engine ------------------------------------------------------------

let child = null
let childPort = 0
let readyPromise = null
let idleTimer = null
let lastError = null
const log = []

function push(line) {
  for (const part of String(line).split('\n')) {
    if (!part.trim()) continue
    log.push(part)
    if (log.length > 200) log.shift()
  }
}

function killServer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!child) return
  try {
    child.kill('SIGKILL')
  } catch {}
  child = null
  readyPromise = null
}

function touchIdle(dataDir) {
  if (idleTimer) clearTimeout(idleTimer)
  const minutes = ttsConfig(dataDir).idleMinutes
  // Zero means "keep it warm until the manager stops".
  if (!minutes) return
  idleTimer = setTimeout(() => killServer(), minutes * 60_000)
  idleTimer.unref?.()
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Start the TTS server if it is not up, and wait until it answers. */
function ensureServer(dataDir) {
  const cfg = ttsConfig(dataDir)
  if (child && childPort === cfg.port) {
    touchIdle(dataDir)
    return readyPromise
  }

  killServer()
  const engine = resolveEngine(dataDir)
  if (!engine?.exists) return Promise.reject(new Error('no llama.cpp engine is installed'))
  if (!existsSync(cfg.model)) return Promise.reject(new Error('no TTS backbone model is set'))
  if (!existsSync(cfg.mmproj)) return Promise.reject(new Error('no TTS codec model is set'))

  const args = [
    '-m', cfg.model,
    '-mm', cfg.mmproj,
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
    '--tts-lang', cfg.lang,
    '-ngl', String(cfg.ngl),
    '-c', '4096',
  ]

  childPort = cfg.port
  lastError = null
  child = spawn(engine.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => push(d))
  child.stderr.on('data', (d) => push(d))
  child.on('exit', (code) => {
    if (code && code !== 0) lastError = `speech engine exited ${code}`
    child = null
    readyPromise = null
  })

  readyPromise = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!child) throw new Error(lastError ?? 'speech engine stopped')
      if (await health(cfg.port)) {
        touchIdle(dataDir)
        return true
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    killServer()
    throw new Error('speech engine did not start in time')
  })()

  return readyPromise
}

// One sentence at a time: the server would queue them anyway, and serialising
// keeps the cache deterministic (no two identical requests in flight).
let chain = Promise.resolve()
function serialise(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

function cacheKey({ model, mmproj, lang, voice, text }) {
  return createHash('sha1').update([model, mmproj, lang, voice, text].join('\u0000')).digest('hex')
}

/**
 * Synthesise one utterance and return WAV bytes.
 *
 * `voice` is an id from listVoices. The clip travels as `speaker_ref_b64` so one
 * warm process can clone any voice without restarting.
 */
export async function speak(dataDir, { text, voice }) {
  const cfg = ttsConfig(dataDir)
  if (!cfg.enabled) throw new Error('speech is off')

  const body = String(text ?? '').trim()
  if (!body) throw new Error('nothing to say')
  if (body.length > MAX_TEXT) throw new Error('text is too long for one utterance')

  const clip = await voiceFile(dataDir, voice)
  if (!clip) throw new Error('no voice clip is selected')

  const key = cacheKey({ model: cfg.model, mmproj: cfg.mmproj, lang: cfg.lang, voice, text: body })
  const dir = cacheDir(dataDir)
  const out = join(dir, `${key}.wav`)
  await mkdir(dir, { recursive: true })
  if (existsSync(out)) return { bytes: await readFile(out), cached: true }

  return serialise(async () => {
    // A queued sibling may have produced it already.
    if (existsSync(out)) return { bytes: await readFile(out), cached: true }

    await ensureServer(dataDir)
    touchIdle(dataDir)

    const payload = JSON.stringify({
      input: body,
      lang: cfg.lang,
      response_format: 'wav',
      speaker_ref_b64: (await readFile(clip)).toString('base64'),
    })

    const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    })

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`speech engine refused: ${res.status} ${detail}`)
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!bytes.length) throw new Error('speech engine returned no audio')
    await writeFile(out, bytes)
    return { bytes, cached: false }
  })
}

export async function describe(dataDir) {
  const cfg = ttsConfig(dataDir)
  const engine = resolveEngine(dataDir)
  const model = await fileInfo(cfg.model)
  const mmproj = await fileInfo(cfg.mmproj)
  const voices = await listVoices(dataDir)
  let cacheFiles = 0
  try {
    cacheFiles = (await readdir(cacheDir(dataDir))).filter((f) => f.endsWith('.wav')).length
  } catch {}

  return {
    enabled: cfg.enabled,
    // Ready means: engine present, both GGUFs present, at least one clip. A
    // speaker with no voice is not usable, so it is not "ready".
    ready: Boolean(engine?.exists) && model.exists && mmproj.exists && voices.length > 0,
    engine: { path: engine?.path ?? '', exists: Boolean(engine?.exists) },
    model,
    mmproj,
    lang: cfg.lang,
    ngl: cfg.ngl,
    port: cfg.port,
    idleMinutes: cfg.idleMinutes,
    serverRunning: Boolean(child),
    error: lastError,
    voices,
    cacheFiles,
    log: log.slice(-20),
  }
}

/** Called on manager shutdown, and by the tests. */
export function shutdown() {
  killServer()
}
