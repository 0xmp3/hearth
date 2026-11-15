// Embeddings, the same way speech works: the manager owns the engine, the app
// just asks.
//
// Why a second process instead of a model in the router's preset: router mode
// runs `--models-max 1` and **unloads the current model on every switch**, so an
// embedding model in that list would evict the chat model on every query and pay
// a full reload to get it back. A dedicated server on its own port stays warm,
// costs ~300 MB, and idles out when nobody is indexing.
//
// Measured on this machine (2026-11-16, EmbeddingGemma-300M-Q8_0, custom ROCm
// build 0.4.0-dev): 768 dimensions, already L2-normalised, 5 ms for a short
// query, ~334 chunks/s batched. The build registers the `gemma-embedding`
// architecture and accepts `--embeddings` / `--pooling`, which is the whole
// reason this module can exist at all.
//
// The vectors themselves are the app's business — they live in IndexedDB next to
// the messages they came from. This module only turns text into numbers.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { readConfig, resolveEngine, writeConfig } from '../engine/resolve.mjs'

const READY_TIMEOUT_MS = 90_000
const EMBED_TIMEOUT_MS = 60_000
const DEFAULT_PORT = 8099
const MAX_INPUTS = 64
const MAX_CHARS = 8000
const POOLING = new Set(['none', 'mean', 'cls', 'last', 'rank'])

const DEFAULTS = {
  // Off until the user points it at a model: an embedding server that starts
  // itself on a machine with no embedding GGUF is a process that can only fail.
  enabled: false,
  model: '',
  port: DEFAULT_PORT,
  ngl: 99,
  pooling: 'mean',
  /**
   * Prefixed to every text before it is embedded. Two of them, because a
   * retrieval model is trained with a *different* prompt for a document than for
   * a query, and using one for both is the quietest way to make retrieval return
   * nothing.
   *
   * These are EmbeddingGemma's card prompts, and they earned the default: on a
   * 40-message corpus the card's document prompt ranked the answer 3rd, 1st and
   * 6th, where the query prompt on documents gave 7th, 2nd and 15th. A 6-message
   * fixture had suggested the opposite, which is why both are configuration and
   * the calibration set in docs/rag.md decides.
   */
  prefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
  /** Minutes of silence before the server is stopped again. */
  idleMinutes: 10,
}

export function embedConfig(dataDir) {
  const cfg = readConfig(dataDir)
  return { ...DEFAULTS, ...(cfg.embed ?? {}) }
}

export function saveEmbedConfig(dataDir, patch) {
  const next = { ...DEFAULTS, ...embedConfig(dataDir) }
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue
    if (key === 'enabled') next.enabled = patch.enabled === true
    else if (key === 'ngl') next.ngl = Math.max(0, Math.min(999, Number(patch.ngl) || 0))
    else if (key === 'port') next.port = Math.max(1024, Math.min(65535, Number(patch.port) || DEFAULT_PORT))
    else if (key === 'idleMinutes') next.idleMinutes = Math.max(0, Math.min(240, Number(patch.idleMinutes) || 0))
    else if (key === 'pooling') {
      const p = String(patch.pooling ?? '').toLowerCase()
      if (!POOLING.has(p)) throw new Error(`pooling must be one of ${[...POOLING].join(', ')}`)
      next.pooling = p
    } else if (key === 'prefix' || key === 'queryPrefix') {
      const p = String(patch[key] ?? '')
      if (p.length > 200) throw new Error(`${key} is longer than 200 characters`)
      next[key] = p
    } else next[key] = String(patch[key])
  }
  writeConfig(dataDir, { embed: next })
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

// ---- the engine ------------------------------------------------------------

let child = null
let childPort = 0
let childModel = ''
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

/**
 * Stop the engine and wait for it to actually be gone.
 *
 * Waiting matters: `kill` is asynchronous, and spawning the replacement before
 * the old process has released the port means the new server fails to bind while
 * the old one keeps answering — so a model switch silently returns vectors from
 * the model you just replaced. That happened, and it looked like a bad model.
 */
function killServer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const proc = child
  child = null
  childModel = ''
  readyPromise = null
  if (!proc) return Promise.resolve()

  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    proc.once('exit', finish)
    try {
      proc.kill('SIGKILL')
    } catch {
      finish()
    }
    // A process that will not die must not hang the request forever.
    setTimeout(finish, 3000).unref?.()
  })
}

function touchIdle(dataDir) {
  if (idleTimer) clearTimeout(idleTimer)
  const minutes = embedConfig(dataDir).idleMinutes
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

async function ensureServer(dataDir) {
  const cfg = embedConfig(dataDir)
  // The model is part of the identity of the running server, not just the port:
  // changing the model in Settings must reload it, or every vector after the
  // change is produced by the old model while the config claims otherwise.
  if (child && childPort === cfg.port && childModel === cfg.model) {
    touchIdle(dataDir)
    return readyPromise
  }

  await killServer()
  const engine = resolveEngine(dataDir)
  if (!engine?.exists) throw new Error('no llama.cpp engine is installed')
  if (!cfg.model) throw new Error('no embedding model is set')
  if (!existsSync(cfg.model)) throw new Error(`embedding model not found: ${cfg.model}`)

  const args = [
    '-m', cfg.model,
    // Restricts the server to the embedding use case: no chat endpoint, no
    // sampling, and the model is loaded with the right graph.
    '--embeddings',
    '--pooling', cfg.pooling,
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
    '-ngl', String(cfg.ngl),
    // Per-sequence context. A chunk is a message, not a document; 2048 tokens
    // is several times the largest chunk the client will send.
    '-c', '2048',
  ]

  childPort = cfg.port
  childModel = cfg.model
  lastError = null
  const proc = spawn(engine.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  proc.stdout.on('data', (d) => push(d))
  proc.stderr.on('data', (d) => push(d))
  proc.on('exit', (code) => {
    // Only the *current* child may clear the state. A replaced server's exit
    // event arrives after its replacement is already running, and clearing here
    // would orphan the new one: the next request would spawn a second server on
    // a port that is already taken.
    if (child !== proc) return
    if (code && code !== 0) lastError = `embedding engine exited ${code}`
    child = null
    childModel = ''
    readyPromise = null
  })

  readyPromise = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child !== proc) throw new Error(lastError ?? 'embedding engine stopped')
      if (await health(cfg.port)) {
        touchIdle(dataDir)
        return true
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    await killServer()
    throw new Error('embedding engine did not start in time')
  })()

  return readyPromise
}

// One request at a time. The server has a single slot, and two concurrent
// batches do not queue politely — the same lesson the memory and compaction
// passes taught (PLAN.md trap 14).
let chain = Promise.resolve()
function serialise(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/**
 * Turn text into vectors.
 *
 * Returns plain arrays rather than Float32Array: this crosses JSON, and the
 * client is the one that decides how to store them.
 */
export async function embed(dataDir, { input, kind }) {
  const cfg = embedConfig(dataDir)
  if (!cfg.enabled) throw new Error('embeddings are off')

  const list = (Array.isArray(input) ? input : [input]).map((t) => String(t ?? ''))
  if (!list.length) throw new Error('nothing to embed')
  if (list.length > MAX_INPUTS) throw new Error(`at most ${MAX_INPUTS} inputs per call`)
  for (const text of list) {
    if (!text.trim()) throw new Error('an input was empty')
    if (text.length > MAX_CHARS) throw new Error(`an input is longer than ${MAX_CHARS} characters`)
  }

  // The task prefix is applied here, not by the caller, so indexing and querying
  // cannot drift apart — a query embedded without the prefix the documents were
  // embedded with is the quietest way to make retrieval return nothing.
  const taskPrefix = kind === 'query' ? cfg.queryPrefix : cfg.prefix
  const prefixed = list.map((text) => taskPrefix + text)

  return serialise(async () => {
    await ensureServer(dataDir)
    touchIdle(dataDir)

    const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // llama-server ignores the model name for a single loaded model, but the
      // field is required by the OpenAI shape, so send something honest.
      body: JSON.stringify({ model: basename(cfg.model, extname(cfg.model)), input: prefixed }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    })

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`embedding engine refused: ${res.status} ${detail}`)
    }

    const body = await res.json()
    const rows = Array.isArray(body?.data) ? body.data : []
    if (rows.length !== list.length) {
      throw new Error(`embedding engine returned ${rows.length} vectors for ${list.length} inputs`)
    }

    const vectors = rows.map((row) => {
      const v = row?.embedding
      if (!Array.isArray(v) || !v.length) throw new Error('embedding engine returned an empty vector')
      return v
    })

    return {
      model: cfg.model,
      dims: vectors[0].length,
      vectors,
      tokens: body?.usage?.total_tokens ?? null,
    }
  })
}

export async function describe(dataDir) {
  const cfg = embedConfig(dataDir)
  const engine = resolveEngine(dataDir)
  const model = await fileInfo(cfg.model)

  return {
    enabled: cfg.enabled,
    // Ready means: engine present and a model that exists. Nothing else is
    // required — the server starts on demand.
    ready: Boolean(engine?.exists) && model.exists,
    engine: { path: engine?.path ?? '', exists: Boolean(engine?.exists) },
    model,
    port: cfg.port,
    pooling: cfg.pooling,
    prefix: cfg.prefix,
    queryPrefix: cfg.queryPrefix,
    ngl: cfg.ngl,
    idleMinutes: cfg.idleMinutes,
    serverRunning: Boolean(child),
    error: lastError,
    log: log.slice(-20),
  }
}

/** Called on manager shutdown, and by the tests. */
export function shutdown() {
  killServer()
}
