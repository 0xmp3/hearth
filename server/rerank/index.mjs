// Reranking: a third engine, and the reason retrieval became usable.
//
// A bi-encoder embeds the query and the passage *separately*, so it can only
// compare two summaries of meaning. A cross-encoder reads them together and
// scores the pair, which is exactly the judgement a short chat message needs —
// "That place spoiled us" and "the town we visited" are close in embedding space
// and obviously different to a model that can see both at once.
//
// Measured on this machine (2026-11-16), bge-reranker-v2-m3-Q8_0 over the top 10
// embedding candidates, two fixtures, six questions:
//
//   embedding alone      ranks 3, 1, 7, 1, 4, 3   → 1 of 6 at rank 1
//   embedding + rerank   ranks 0, 0, 2, 3, 0, 1   → 3 of 6 at rank 1, all in top 3
//
// Reranking 10 candidates scored identically to 20, so 10 is the default: half
// the work for the same answer.
//
// **It runs on the CPU by default, and that is a VRAM decision.** A 14 GB chat
// model on a 16 GB card leaves no room for a 0.6 GB reranker plus its context, and
// llama.cpp would spill layers rather than say so. Measured: 42 ms for 20
// documents on the GPU, 622 ms on the CPU — slower, and it cannot cost the user
// their model mid-reply. `ngl` is configuration for machines with headroom.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { readConfig, resolveEngine, writeConfig } from '../engine/resolve.mjs'

const READY_TIMEOUT_MS = 90_000
const RERANK_TIMEOUT_MS = 60_000
const DEFAULT_PORT = 8098
const MAX_DOCUMENTS = 64
const MAX_CHARS = 8000

const DEFAULTS = {
  enabled: false,
  model: '',
  port: DEFAULT_PORT,
  /** 0 = CPU. See the note at the top: the GPU is usually the chat model's. */
  ngl: 0,
  /** How many embedding candidates to reorder. 10 measured the same as 20. */
  candidates: 10,
  idleMinutes: 10,
}

export function rerankConfig(dataDir) {
  const cfg = readConfig(dataDir)
  return { ...DEFAULTS, ...(cfg.rerank ?? {}) }
}

export function saveRerankConfig(dataDir, patch) {
  const next = { ...DEFAULTS, ...rerankConfig(dataDir) }
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue
    if (key === 'enabled') next.enabled = patch.enabled === true
    else if (key === 'ngl') next.ngl = Math.max(0, Math.min(999, Number(patch.ngl) || 0))
    else if (key === 'port') next.port = Math.max(1024, Math.min(65535, Number(patch.port) || DEFAULT_PORT))
    else if (key === 'candidates') next.candidates = Math.max(1, Math.min(64, Number(patch.candidates) || 10))
    else if (key === 'idleMinutes') next.idleMinutes = Math.max(0, Math.min(240, Number(patch.idleMinutes) || 0))
    else next[key] = String(patch[key])
  }
  writeConfig(dataDir, { rerank: next })
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

/** Stop the engine and wait for it to release the port. See embed/index.mjs. */
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
    setTimeout(finish, 3000).unref?.()
  })
}

function touchIdle(dataDir) {
  if (idleTimer) clearTimeout(idleTimer)
  const minutes = rerankConfig(dataDir).idleMinutes
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
  const cfg = rerankConfig(dataDir)
  if (child && childPort === cfg.port && childModel === cfg.model) {
    touchIdle(dataDir)
    return readyPromise
  }

  await killServer()
  const engine = resolveEngine(dataDir)
  if (!engine?.exists) throw new Error('no llama.cpp engine is installed')
  if (!cfg.model) throw new Error('no reranker model is set')
  if (!existsSync(cfg.model)) throw new Error(`reranker model not found: ${cfg.model}`)

  const args = [
    '-m', cfg.model,
    '--rerank',
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
    '-ngl', String(cfg.ngl),
    // Query plus one document has to fit; 2048 is generous for a chat message.
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
    if (child !== proc) return
    if (code && code !== 0) lastError = `reranker exited ${code}`
    child = null
    childModel = ''
    readyPromise = null
  })

  readyPromise = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child !== proc) throw new Error(lastError ?? 'reranker stopped')
      if (await health(cfg.port)) {
        touchIdle(dataDir)
        return true
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    await killServer()
    throw new Error('reranker did not start in time')
  })()

  return readyPromise
}

let chain = Promise.resolve()
function serialise(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/**
 * Score documents against a query.
 *
 * Returns `{index, score}` in descending order, where `index` is the position in
 * the array that was sent. The score is a raw logit, not a probability: it is
 * comparable within one call and meaningless across calls, so it orders
 * candidates and does not decide a threshold.
 */
export async function rerank(dataDir, { query, documents, topN }) {
  const cfg = rerankConfig(dataDir)
  if (!cfg.enabled) throw new Error('reranking is off')

  const q = String(query ?? '').trim()
  if (!q) throw new Error('nothing to rerank against')
  if (q.length > MAX_CHARS) throw new Error('the query is too long')

  const docs = (Array.isArray(documents) ? documents : []).map((d) => String(d ?? ''))
  if (!docs.length) throw new Error('no documents to rerank')
  if (docs.length > MAX_DOCUMENTS) throw new Error(`at most ${MAX_DOCUMENTS} documents per call`)
  for (const d of docs) {
    if (!d.trim()) throw new Error('a document was empty')
    if (d.length > MAX_CHARS) throw new Error(`a document is longer than ${MAX_CHARS} characters`)
  }

  return serialise(async () => {
    await ensureServer(dataDir)
    touchIdle(dataDir)

    const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: basename(cfg.model, extname(cfg.model)),
        query: q,
        documents: docs,
        ...(topN ? { top_n: Math.min(topN, docs.length) } : {}),
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    })

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`reranker refused: ${res.status} ${detail}`)
    }

    const body = await res.json()
    const rows = Array.isArray(body?.results) ? body.results : []
    if (!rows.length) throw new Error('reranker returned nothing')

    return {
      model: cfg.model,
      results: rows.map((row) => ({ index: Number(row.index), score: Number(row.relevance_score) })),
      tokens: body?.usage?.total_tokens ?? null,
    }
  })
}

export async function describe(dataDir) {
  const cfg = rerankConfig(dataDir)
  const engine = resolveEngine(dataDir)
  const model = await fileInfo(cfg.model)

  return {
    enabled: cfg.enabled,
    ready: Boolean(engine?.exists) && model.exists,
    engine: { path: engine?.path ?? '', exists: Boolean(engine?.exists) },
    model,
    port: cfg.port,
    ngl: cfg.ngl,
    candidates: cfg.candidates,
    idleMinutes: cfg.idleMinutes,
    serverRunning: Boolean(child),
    error: lastError,
    log: log.slice(-20),
  }
}

export function shutdown() {
  killServer()
}
