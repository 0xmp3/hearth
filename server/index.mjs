// Hearth backend manager.
//
// A browser cannot spawn a process or write a file, so this small local service
// does both: it owns llama-server, and it stores uploads in the app's own data
// directory. The app talks to it over HTTP and stays a plain web app.
//
// Security: binds to 127.0.0.1 only, requires a custom header (which forces a
// CORS preflight, so a random web page cannot POST here), and only answers
// origins on localhost. It can spawn a process and write files, so it must not
// be reachable from anywhere else.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as metrics from './metrics/index.mjs'
import { serverView } from './metrics/server-view.mjs'
import { buildPreset } from './engine/preset.mjs'
import { detect } from './engine/detect.mjs'
import { pickSource } from './engine/catalog.mjs'
import { install, adoptLegacy, progress, isInstalled } from './engine/install.mjs'
import { readUrl } from './net/fetch.mjs'
import { webSearch } from './net/search.mjs'
import * as searxng from './searxng/install.mjs'
import * as tts from './tts/index.mjs'
import * as embed from './embed/index.mjs'
import * as rerank from './rerank/index.mjs'
import * as rerankDownload from './rerank/download.mjs'
import * as ws from './workspace/files.mjs'
import {
  BIN,
  engineDir,
  readConfig,
  resolveEngine,
  resolveModelsDir,
  writeConfig,
} from './engine/resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')

const PORT = Number(process.env.HEARTH_MANAGER_PORT ?? 8090)
const LLAMA_PORT = Number(process.env.HEARTH_LLAMA_PORT ?? 8088)

const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

let child = null
let startedAt = null
let lastArgs = null
let lastError = null
let installing = false
const log = []

function push(line) {
  for (const part of String(line).split('\n')) {
    if (!part.trim()) continue
    log.push(part)
    if (log.length > 400) log.shift()
  }
}

function status() {
  return {
    running: Boolean(child),
    pid: child?.pid ?? null,
    startedAt,
    args: lastArgs,
    port: LLAMA_PORT,
    error: lastError,
    log: log.slice(-80),
  }
}

function stop() {
  if (!child) return false
  push(`[manager] stopping pid ${child.pid}`)
  child.kill()
  child = null
  startedAt = null
  return true
}

function start({ ctx, ngl }) {
  if (child) throw new Error('already running — stop it first')

  const engine = resolveEngine(DATA)
  if (!engine.path) {
    throw new Error('no engine — download one, or set a path in Settings')
  }
  if (!engine.exists) {
    throw new Error(`engine not found at ${engine.path}`)
  }

  const models = resolveModelsDir(DATA)
  if (!models.path) {
    throw new Error('no models folder — set one in Settings')
  }
  if (!models.exists) {
    throw new Error(`models folder not found: ${models.path}`)
  }

  const cfg = readConfig(DATA)
  const useCtx = ctx ?? cfg.ctx ?? 16384
  const useNgl = ngl ?? cfg.ngl ?? 99
  const useHost = cfg.bindHost || '127.0.0.1'

  // A preset is generated on every start so new models and new projectors are
  // picked up. It replaces --models-dir: the preset lists every model itself,
  // and it is the only way to give one of them an mmproj.
  const preset = buildPreset(models.path, join(DATA, 'models-preset.ini'), {
    ctx: useCtx,
    ngl: useNgl,
  })
  push(
    `[manager] preset: ${preset.models.length} model(s)` +
      (preset.withVision.length ? `, vision: ${preset.withVision.join(', ')}` : ', no projectors'),
  )

  const args = [
    '--models-preset', preset.path,
    '--models-max', '1',
    '--host', useHost,
    '--port', String(LLAMA_PORT),
    '--jinja',
    // Exposes /metrics, which is where the KV cache and slot numbers come from.
    '--metrics',
  ]

  lastError = null
  lastArgs = args
  push(`[manager] ${engine.path} ${args.join(' ')}`)

  // cwd is the engine's own folder: the build's DLLs sit next to the binary and
  // Windows resolves them relative to the working directory.
  child = spawn(engine.path, args, { cwd: dirname(engine.path), windowsHide: true })
  startedAt = Date.now()

  child.stdout.on('data', (d) => push(d.toString()))
  child.stderr.on('data', (d) => push(d.toString()))

  child.on('exit', (code, signal) => {
    push(`[manager] exited code=${code} signal=${signal}`)
    if (code !== 0 && code !== null) lastError = `llama-server exited with code ${code}`
    child = null
    startedAt = null
  })

  child.on('error', (err) => {
    lastError = err.message
    push(`[manager] spawn error: ${err.message}`)
    child = null
  })

  return status()
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function cors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hearth')
}

function readBody(req, limit = 25e6) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('file too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Only these shapes are ever written or read: a known folder and a generated
// filename. Nothing from the client becomes a path.
const SAFE_PATH = /^(avatars|attachments)\/[A-Za-z0-9._-]+$/

/**
 * A bounded whole number, or a refusal.
 *
 * `ctx` and `ngl` are written straight into the generated preset INI, so a
 * string carrying a newline is not a bad number — it is extra lines in a config
 * file that tells llama-server which GGUF to load.
 */
function wholeNumber(value, name, lo, hi) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`${name} must be a whole number between ${lo} and ${hi}`)
  }
  return n
}

async function handleUpload(req, res, url) {
  const kind = url.searchParams.get('kind') === 'attachment' ? 'attachments' : 'avatars'
  const type = String(req.headers['content-type'] ?? '')
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'

  try {
    const buf = await readBody(req)
    if (!buf.length) return json(res, 400, { error: 'empty body' })

    const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${ext}`
    const dir = join(DATA, kind)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), buf)

    push(`[manager] stored ${kind}/${name} (${buf.length} bytes)`)
    json(res, 200, { url: `/api/file/${kind}/${name}`, name, size: buf.length })
  } catch (err) {
    json(res, 400, { error: err.message })
  }
}

async function handleFile(res, url) {
  let rel
  try {
    rel = decodeURIComponent(url.pathname.slice('/api/file/'.length))
  } catch {
    // A malformed escape (`%`, `%zz`) throws URIError. It used to escape the
    // whole handler and take the process with it, unauthenticated, from an <img>.
    return json(res, 400, { error: 'bad path' })
  }
  if (!SAFE_PATH.test(rel)) return json(res, 400, { error: 'bad path' })

  const full = normalize(join(DATA, rel))
  if (!full.startsWith(normalize(DATA) + sep)) return json(res, 403, { error: 'outside data' })

  try {
    const buf = await readFile(full)
    const ext = rel.split('.').pop()?.toLowerCase() ?? ''
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      // The declared type is right, but nothing is gained by letting a browser
      // decide for itself.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'max-age=31536000, immutable',
    })
    res.end(buf)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

/**
 * Theme files. The manager only reads and parses them; validation lives in the
 * app, next to the type it validates against. A file that will not parse is
 * reported rather than thrown, so one bad theme cannot break the list.
 */
async function handleThemes(res) {
  const dir = join(DATA, 'themes')
  const files = []
  const problems = []

  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    // No themes folder yet is the normal case, not an error.
    return json(res, 200, { files, problems })
  }

  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      files.push({ name, data: JSON.parse(raw) })
    } catch (err) {
      problems.push({ file: name, reason: err.message })
    }
  }

  json(res, 200, { files, problems })
}

/** Everything the UI needs to explain the current setup. */
async function engineStatus() {
  const detected = await detect()
  const source = pickSource(detected)
  const engine = resolveEngine(DATA)
  const models = resolveModelsDir(DATA)
  const cfg = readConfig(DATA)

  // A build from before the marker existed still counts as installed. Do this
  // before reporting, so the panel never offers a re-download over a working
  // engine.
  await adoptLegacy(engineDir(DATA), BIN)

  return {
    detected,
    source,
    engine,
    models,
    config: cfg,
    managed: {
      dir: engineDir(DATA),
      installed: await isInstalled(engineDir(DATA), BIN),
    },
    progress,
    installing,
  }
}

const server = createServer((req, res) => {
  cors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  // Images are loaded by <img>, which cannot send custom headers, so the file
  // endpoint is the one read-only route without the guard. It is path-checked,
  // and every line of the handler is inside a try: an unhandled throw from a
  // `void`ed async call ends the process, which this route proved the hard way.
  if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
    handleFile(res, url).catch((err) => {
      json(res, 500, { error: err.message })
    })
    return
  }

  // A custom header cannot be sent cross-origin without a preflight, which we
  // only answer for allowed origins. This is the CSRF guard.
  if (req.headers['x-hearth'] !== '1') {
    json(res, 403, { error: 'missing X-Hearth header' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, status())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/themes') {
    handleThemes(res).catch((err) => json(res, 500, { error: err.message }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/engine') {
    engineStatus()
      .then((s) => json(res, 200, s))
      .catch((err) => json(res, 500, { error: err.message }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const model = url.searchParams.get('model')
    const models = resolveModelsDir(DATA)
    Promise.all([
      metrics.snapshot(models.path ?? DATA),
      serverView(LLAMA_PORT, model).catch(() => null),
    ])
      .then(([system, server]) => json(res, 200, { system, server, sampling: metrics.running() }))
      .catch((err) => json(res, 500, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/metrics/start') {
    metrics.start()
    json(res, 200, { sampling: metrics.running() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/metrics/stop') {
    metrics.stop()
    json(res, 200, { sampling: metrics.running() })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/engine/progress') {
    json(res, 200, { progress, installing })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/engine/download') {
    if (installing) return json(res, 409, { error: 'already downloading' })

    detect()
      .then((detected) => {
        const source = pickSource(detected)
        if (!source) throw new Error('no build available for this machine')

        installing = true
        // Fire and forget: the UI polls /api/engine/progress.
        install(source, engineDir(DATA))
          .catch((err) => push(`[manager] install failed: ${err.message}`))
          .finally(() => {
            installing = false
          })

        json(res, 202, { started: true, source })
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- network ----------------------------------------------------------
  // Egress lives here so there is exactly one place that can reach the
  // internet, and one place that can refuse to.

  if (req.method === 'GET' && url.pathname === '/api/network') {
    json(res, 200, { enabled: readConfig(DATA).network === true })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/network') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false')
        const cfg = writeConfig(DATA, { network: body.enabled })
        push(`[net] network access ${body.enabled ? 'on' : 'off'}`)
        json(res, 200, { enabled: cfg.network === true })
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- workspace ---------------------------------------------------------
  // A folder the model may read. The manager owns the path and the guard; the
  // app only learns whether one is configured, because it cannot read files.

  const workspaceState = async () => {
    const cfg = readConfig(DATA)
    const w = cfg.workspace ?? {}
    const enabled = w.enabled === true
    if (!w.path) return { enabled, path: '', exists: false }
    try {
      const root = await ws.resolveRoot(w.path)
      return { enabled, path: root, exists: true }
    } catch (err) {
      return { enabled, path: w.path, exists: false, error: err.message }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/workspace') {
    workspaceState().then((state) => json(res, 200, state))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/workspace') {
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const cfg = readConfig(DATA)
        const current = cfg.workspace ?? {}
        const next = { ...current }

        if (typeof body.path === 'string') {
          const path = body.path.trim()
          if (path) {
            // Refuse a bad folder at the point it is set, not on the first read.
            await ws.resolveRoot(path)
          }
          next.path = path
        }
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled
        writeConfig(DATA, { workspace: next })
        push(`[workspace] ${next.enabled ? 'on' : 'off'} — ${next.path || '(none)'}`)
        json(res, 200, await workspaceState())
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  const workspaceOp = async (res, run) => {
    const cfg = readConfig(DATA)
    const w = cfg.workspace ?? {}
    if (w.enabled !== true) return json(res, 403, { error: 'workspace access is off' })
    try {
      const root = await ws.resolveRoot(w.path)
      json(res, 200, await run(root))
    } catch (err) {
      json(res, 400, { error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/workspace/list') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        return workspaceOp(res, (root) => ws.listTree(root, body.path ?? '.', body))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/workspace/search') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        return workspaceOp(res, (root) => ws.searchFiles(root, body.query, body))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/workspace/read') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        return workspaceOp(res, (root) => ws.readWorkspaceFile(root, body.path, body))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- managed SearXNG ---------------------------------------------------
  // The address of the managed instance is *computed*, not stored: it exists
  // exactly while the process runs. Storing it invited a read-modify-write race
  // — a settings save landing between start() and the write dropped the URL and
  // took search down with it.

  const effectiveSearch = () => {
    const cfg = readConfig(DATA)
    const saved = cfg.search ?? {}
    const managed = searxng.status(DATA)
    return {
      ...saved,
      searxngUrl: saved.searxngUrl || (managed.running ? managed.url : ''),
    }
  }

  // The install that needs no key and no account. It is a Python app, so the
  // manager builds a venv, installs the pinned requirements, and owns the
  // process — the same shape as the engine, with a much slower first run.

  if (req.method === 'GET' && url.pathname === '/api/searxng') {
    // The Python probe is a process spawn, so it is done here rather than in the
    // sync status() the internals use.
    searxng
      .findPython()
      .then((python) => json(res, 200, { ...searxng.status(DATA), python }))
      .catch(() => json(res, 200, { ...searxng.status(DATA), python: null }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/searxng/install') {
    json(res, 202, { started: true })
    searxng
      .install(DATA)
      .then(async () => {
        // Installing ends with it running: "installed" is not a state a user
        // asked for, it is a step.
        await searxng.start(DATA)
        push('[searxng] install complete and running')
      })
      .catch((err) => push(`[searxng] install error: ${err.message}`))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/searxng/start') {
    searxng
      .start(DATA)
      .then((state) => json(res, 200, state))
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/searxng/stop') {
    const stopped = searxng.stop(DATA)
    json(res, 200, { stopped, ...searxng.status(DATA) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/searxng/remove') {
    searxng
      .uninstall(DATA)
      .then(() => {
        const cfg = readConfig(DATA)
        const search = { ...(cfg.search ?? {}) }
        if ((search.searxngUrl ?? '').startsWith('http://127.0.0.1:')) search.searxngUrl = ''
        writeConfig(DATA, { search })
        json(res, 200, { removed: true, ...searxng.status(DATA) })
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- backend proxy ------------------------------------------------------
  //
  // The browser cannot talk to an arbitrary local server: most of them send no
  // CORS headers (Strata's Python server does not), and the ones that do are the
  // exception. So the manager proxies the two calls the app needs and the app
  // only ever talks to 127.0.0.1:8090.
  //
  // This is also the seam where a backend that is not llama.cpp gets normalised:
  // one place to fix a shape, instead of one per engine.
  //
  // Loopback only, unless the user says otherwise. `baseUrl` arrives in a request
  // body, so an unconstrained proxy here is a request-forgery primitive that also
  // bypasses the `network` switch — the app could POST to a LAN address or a
  // metadata endpoint with a body of its choosing. A backend on another machine
  // (a test VM, say) is the reason the opt-in exists, and it is one setting.

  const loopbackHost = (url) => {
    const host = url.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  }

  const backendBase = (raw) => {
    let url
    try {
      url = new URL(String(raw || `http://127.0.0.1:${LLAMA_PORT}`))
    } catch {
      throw new Error('the backend address is not a URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('the backend must be an http(s) address')
    }
    if (!loopbackHost(url) && readConfig(DATA).allowRemoteBackend !== true) {
      throw new Error(
        `refusing to proxy to ${url.hostname}: only a loopback backend is allowed unless "allowRemoteBackend" is turned on in Settings`,
      )
    }
    return url.origin + url.pathname.replace(/\/+$/, '')
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    let base
    try {
      base = backendBase(url.searchParams.get('baseUrl'))
    } catch (err) {
      json(res, 400, { error: err.message })
      return
    }
    fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(20_000) })
      .then(async (upstream) => {
        const text = await upstream.text()
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        })
        res.end(text)
      })
      .catch((err) => json(res, 502, { error: `backend unreachable: ${err.message}` }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    readBody(req, 25e6)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const base = backendBase(body.baseUrl)
        delete body.baseUrl

        // A client that goes away must stop the generation, not leave it running
        // against a 48 GB model.
        const abort = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) abort.abort()
        })

        const upstream = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abort.signal,
        })

        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        })

        if (!upstream.body) {
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            // Write, and wait for the socket to drain: a slow reader must not
            // make the manager buffer a whole reply in memory.
            if (!res.write(Buffer.from(value))) {
              await new Promise((resolve) => res.once('drain', resolve))
            }
          }
        } catch (err) {
          if (!abort.signal.aborted) push(`[chat] stream ended: ${err.message}`)
        } finally {
          res.end()
        }
      })
      .catch((err) => {
        if (!res.headersSent) json(res, 502, { error: `backend unreachable: ${err.message}` })
        else res.end()
      })
    return
  }

  // ---- embeddings ---------------------------------------------------------
  //
  // Same shape as speech: the manager owns a second llama-server, started on
  // demand and idled out. The app never talks to it directly — a local engine
  // sends no CORS headers, so a direct fetch from the page is silently
  // discarded (trap 21). The vectors themselves stay in the browser, next to the
  // messages they were made from; this route only turns text into numbers.

  if (req.method === 'GET' && url.pathname === '/api/embed') {
    embed
      .describe(DATA)
      .then((state) => json(res, 200, state))
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/embed/config') {
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        embed.saveEmbedConfig(DATA, body)
        json(res, 200, await embed.describe(DATA))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/embed') {
    readBody(req, 4e6)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        json(res, 200, await embed.embed(DATA, body))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- reranking ----------------------------------------------------------
  //
  // A cross-encoder over the embedding stage's candidates. Same shape again: the
  // manager owns the engine, the page asks. It runs on the CPU by default so it
  // cannot take the VRAM the chat model is using.

  if (req.method === 'GET' && url.pathname === '/api/rerank') {
    rerank
      .describe(DATA)
      .then((state) => json(res, 200, state))
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rerank/config') {
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        rerank.saveRerankConfig(DATA, body)
        json(res, 200, await rerank.describe(DATA))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rerank') {
    readBody(req, 4e6)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        json(res, 200, await rerank.rerank(DATA, body))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // The reranker is a 300–600 MB file the app has to fetch itself, so it gets the
  // same shape as the engine installer: start it, poll it, verify the digest.
  if (req.method === 'GET' && url.pathname === '/api/rerank/download') {
    rerankDownload
      .describeDownloads(DATA)
      .then((state) => json(res, 200, state))
      .catch((err) => json(res, 500, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rerank/download') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        // Fire and forget: the UI polls the progress object. A download that
        // takes two minutes must not hold a request open.
        rerankDownload.downloadReranker(DATA, body.id).catch((err) => push(`[rerank] ${err.message}`))
        json(res, 200, { started: true, id: body.id ?? null })
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // ---- speech -------------------------------------------------------------
  //
  // The manager owns the engine and the clips; the app only asks for audio. The
  // response is raw WAV because the browser decodes it into an AudioBuffer and
  // schedules it — a data URL would mean base64-ing megabytes per sentence.

  if (req.method === 'GET' && url.pathname === '/api/tts') {
    tts
      .describe(DATA)
      .then((state) => json(res, 200, state))
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/tts/config') {
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        tts.saveTtsConfig(DATA, body)
        json(res, 200, await tts.describe(DATA))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/tts/voices') {
    readBody(req, 30e6)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const voice = await tts.importVoice(DATA, body)
        json(res, 200, { voice, ...(await tts.describe(DATA)) })
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/tts/voices/remove') {
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        await tts.removeVoice(DATA, body.id)
        json(res, 200, await tts.describe(DATA))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/tts/speak') {
    readBody(req, 1e5)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const { bytes, cached } = await tts.speak(DATA, body)
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
          'X-Hearth-Cached': cached ? '1' : '0',
        })
        res.end(bytes)
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  // Search settings. The key is written once and never read back out: the app
  // is told whether one exists, not what it is, so a screenshot of Settings (or
  // a stray backup) cannot carry it away.
  const searchState = () => {
    const s = effectiveSearch()
    const key = process.env.HEARTH_BRAVE_KEY || s.braveKey || ''
    return {
      provider: s.provider ?? 'off',
      hasKey: Boolean(key),
      searxngUrl: s.searxngUrl ?? '',
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    json(res, 200, searchState())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    readBody(req, 1e4)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const cfg = readConfig(DATA)
        const current = cfg.search ?? {}
        const next = { ...current }
        if (body.provider !== undefined) {
          if (!['off', 'brave', 'searxng'].includes(body.provider)) throw new Error('unknown provider')
          next.provider = body.provider
        }
        // An empty string clears the key; omitting the field keeps it, so the
        // app never has to hold the secret to re-save the rest of the form.
        if (typeof body.braveKey === 'string') next.braveKey = body.braveKey.trim()
        if (typeof body.searxngUrl === 'string') next.searxngUrl = body.searxngUrl.trim()
        writeConfig(DATA, { search: next })
        push(`[net] search provider: ${next.provider ?? 'off'}`)
        json(res, 200, searchState())
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/search/run') {
    if (readConfig(DATA).network !== true) {
      json(res, 403, { error: 'network access is off' })
      return
    }
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const settings = {
          ...effectiveSearch(),
          braveKey: process.env.HEARTH_BRAVE_KEY || readConfig(DATA).search?.braveKey || '',
        }
        const started = Date.now()
        try {
          const out = await webSearch(body.q, settings, body.count)
          push(`[net] search "${String(body.q).slice(0, 120)}" via ${out.provider} → ${out.results.length} results, ${Date.now() - started} ms`)
          json(res, 200, out)
        } catch (err) {
          push(`[net] search failed — ${err.message}`)
          json(res, 400, { error: err.message })
        }
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/fetch') {
    if (readConfig(DATA).network !== true) {
      json(res, 403, { error: 'network access is off' })
      return
    }
    readBody(req, 1e4)
      .then(async (buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const started = Date.now()
        try {
          const page = await readUrl(body.url, { maxChars: body.maxChars })
          push(`[net] read ${page.url} → ${page.bytes} bytes, ${page.text.length} chars, ${Date.now() - started} ms`)
          json(res, 200, page)
        } catch (err) {
          push(`[net] refused ${String(body.url).slice(0, 200)} — ${err.message}`)
          json(res, 400, { error: err.message })
        }
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    readBody(req, 1e5)
      .then((buf) => {
        const patch = buf.length ? JSON.parse(buf.toString()) : {}
        const clean = {}

        if (patch.enginePath !== undefined) {
          clean.enginePath = patch.enginePath ? String(patch.enginePath) : null
        }
        if (patch.modelsDir !== undefined) {
          clean.modelsDir = patch.modelsDir ? String(patch.modelsDir) : null
        }
        if (patch.ctx !== undefined) clean.ctx = wholeNumber(patch.ctx, 'ctx', 512, 1048576)
        if (patch.ngl !== undefined) clean.ngl = wholeNumber(patch.ngl, 'ngl', 0, 999)
        if (patch.bindHost !== undefined) {
          const host = String(patch.bindHost || '127.0.0.1').trim()
          // A literal address only: a hostname here would be resolved by
          // llama-server at spawn time, where we cannot see what it resolves to.
          if (!isIP(host)) {
            throw new Error('bindHost must be an IP address — 127.0.0.1, or an adapter address')
          }
          clean.bindHost = host
        }
        if (patch.allowRemoteBackend !== undefined) {
          clean.allowRemoteBackend = patch.allowRemoteBackend === true
        }

        json(res, 200, writeConfig(DATA, clean))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    readBody(req, 1e5)
      .then((buf) => {
        const body = buf.length ? JSON.parse(buf.toString()) : {}
        const opts = {}
        if (body.ctx !== undefined) opts.ctx = wholeNumber(body.ctx, 'ctx', 512, 1048576)
        if (body.ngl !== undefined) opts.ngl = wholeNumber(body.ngl, 'ngl', 0, 999)
        json(res, 200, start(opts))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const stopped = stop()
    json(res, 200, { stopped, ...status() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    handleUpload(req, res, url).catch((err) => {
      json(res, 500, { error: err.message })
    })
    return
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  const engine = resolveEngine(DATA)
  const models = resolveModelsDir(DATA)
  console.log(`hearth manager on http://127.0.0.1:${PORT}`)
  console.log(`  engine:  ${engine.path ?? '(none — download one in Settings)'}  [${engine.source}]`)
  console.log(`  models:  ${models.path ?? '(none — set one in Settings)'}  [${models.source}]`)
  console.log(`  data:    ${DATA}`)
  console.log(`  serving: ${LLAMA_PORT}`)

  // A managed search instance that is installed should be up when the manager
  // is: the user asked for web search to work, not to press Start on every boot.
  // Failures are logged and ignored — search degrades to "not running".
  const cfg = readConfig(DATA)
  if (cfg.search?.provider === 'searxng' && searxng.status(DATA).installed) {
    searxng
      .start(DATA)
      .then((st) => console.log(`  search:  SearXNG on ${st.url}`))
      .catch((err) => console.log(`  search:  SearXNG not started (${err.message})`))
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop()
    metrics.stop()
    searxng.stop(DATA)
    tts.shutdown()
    embed.shutdown()
    rerank.shutdown()
    process.exit(0)
  })
}

// A manager that dies must not leave a Python web server or a second model
// server behind.
process.on('exit', () => {
  searxng.stop(DATA)
  tts.shutdown()
  embed.shutdown()
  rerank.shutdown()
})

// The net under every route. A rejected promise nobody awaited used to end the
// process (Node exits on an unhandled rejection), and one unauthenticated URL
// was enough to find that out. Now it is a log line: a bad request is not a
// reason to take the backend down, and the alternative is the user losing their
// model mid-sentence to a malformed path.
process.on('unhandledRejection', (err) => {
  push(`[manager] unhandled rejection: ${err?.stack ?? String(err)}`)
  console.error('[manager] unhandled rejection:', err)
})

process.on('uncaughtException', (err) => {
  push(`[manager] uncaught exception: ${err?.stack ?? String(err)}`)
  console.error('[manager] uncaught exception:', err)
})
