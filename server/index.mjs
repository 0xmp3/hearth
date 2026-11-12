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
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as metrics from './metrics/index.mjs'
import { serverView } from './metrics/server-view.mjs'
import { buildPreset } from './engine/preset.mjs'
import { detect } from './engine/detect.mjs'
import { pickSource } from './engine/catalog.mjs'
import { install, progress, isInstalled } from './engine/install.mjs'
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
  const rel = decodeURIComponent(url.pathname.slice('/api/file/'.length))
  if (!SAFE_PATH.test(rel)) return json(res, 400, { error: 'bad path' })

  const full = normalize(join(DATA, rel))
  if (!full.startsWith(normalize(DATA) + sep)) return json(res, 403, { error: 'outside data' })

  try {
    const buf = await readFile(full)
    const ext = rel.split('.').pop()?.toLowerCase() ?? ''
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': buf.length,
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
  // endpoint is the one read-only route without the guard. It is path-checked.
  if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
    void handleFile(res, url)
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

  if (req.method === 'POST' && url.pathname === '/api/config') {
    readBody(req, 1e5)
      .then((buf) => {
        const patch = buf.length ? JSON.parse(buf.toString()) : {}
        const allowed = ['enginePath', 'modelsDir', 'ctx', 'ngl']
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([k]) => allowed.includes(k)),
        )
        json(res, 200, writeConfig(DATA, clean))
      })
      .catch((err) => json(res, 400, { error: err.message }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    readBody(req, 1e5)
      .then((buf) => {
        const opts = buf.length ? JSON.parse(buf.toString()) : {}
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
    void handleUpload(req, res, url)
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
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop()
    metrics.stop()
    process.exit(0)
  })
}
