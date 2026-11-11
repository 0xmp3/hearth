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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')

const PORT = Number(process.env.HEARTH_MANAGER_PORT ?? 8090)
const LLAMA = process.env.HEARTH_LLAMA ?? 'C:/AI/Llama Rocm/llama-server.exe'
const DEFAULT_MODELS_DIR = process.env.HEARTH_MODELS ?? 'C:/AI/Models/served'
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

function start({ ctx, modelsDir, ngl }) {
  if (child) throw new Error('already running — stop it first')
  if (!existsSync(LLAMA)) throw new Error(`llama-server not found at ${LLAMA}`)

  const dir = modelsDir || DEFAULT_MODELS_DIR
  if (!existsSync(dir)) throw new Error(`models folder not found: ${dir}`)

  const args = [
    '--models-dir', dir,
    '--models-max', '1',
    '--port', String(LLAMA_PORT),
    '-c', String(ctx ?? 8192),
    '-ngl', String(ngl ?? 99),
    '--jinja',
  ]

  lastError = null
  lastArgs = args
  push(`[manager] ${LLAMA} ${args.join(' ')}`)

  child = spawn(LLAMA, args, { cwd: 'C:/AI/Llama Rocm', windowsHide: true })
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
  console.log(`hearth manager on http://127.0.0.1:${PORT}`)
  console.log(`  llama-server: ${LLAMA}`)
  console.log(`  models:       ${DEFAULT_MODELS_DIR}`)
  console.log(`  data:         ${DATA}`)
  console.log(`  serving on:   ${LLAMA_PORT}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop()
    process.exit(0)
  })
}
