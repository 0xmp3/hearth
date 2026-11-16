// One command to bring Hearth up: the manager on 8090 and the app on 5173.
//
// Why a script and not `npm start && vite`: two shells is the first thing a
// stranger gets wrong, and the failure is quiet — the app opens, the manager is
// not there, and history reads as missing. So both processes are started here,
// their logs are prefixed, and Ctrl+C stops both in the right order.
//
// Three things here are deliberate:
//
//   * **Nothing is spawned that is already listening.** A manager on 8090 may be
//     yours, holding a model. Starting a second one fights it for the port and
//     leaves two llama-servers; so an answering manager is reused, not replaced.
//   * **Ctrl+C asks the manager to stop before the process is killed.** The
//     manager stops llama-server through its own child handle; killing it first
//     orphans the engine on 8088, and another local app may share llama.cpp on
//     the same machine. `/api/stop` first, `kill` as the backstop.
//   * **A wrong Node says so.** `node:sqlite` arrives in Node 24, and without it
//     the manager dies on `import` with an error that names the module and not
//     the cause.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')

const MANAGER_PORT = Number(process.env.HEARTH_MANAGER_PORT ?? 8090)
const MANAGER = `http://127.0.0.1:${MANAGER_PORT}`
// The manager only answers origins on localhost:5173, and vite binds ::1, so
// the app URL is localhost — 127.0.0.1:5173 is a different origin to the
// manager's allow-list and to IndexedDB.
const APP_URL = 'http://localhost:5173'

const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (NODE_MAJOR < 24) {
  console.error(
    `Hearth needs Node 24 or newer (the library is stored with node:sqlite).\n` +
      `You are on Node ${process.versions.node}. Install Node 24, or run Hearth with it on PATH.`,
  )
  process.exit(1)
}

const children = new Map()
let stopping = false

/** Answer from a URL, or null if nothing is listening. Never throws. */
async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(900) })
    return res.status
  } catch {
    return null
  }
}

/** Wait until `url` answers, printing nothing if it never does. */
async function waitFor(url, headers, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await probe(url, headers)) === 200) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Prefix a child's output so two interleaved logs stay readable. */
function pipe(name, child) {
  for (const stream of [child.stdout, child.stderr]) {
    let held = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      held += chunk
      const lines = held.split('\n')
      held = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`[${name}] ${line}`)
    })
  }
}

function start(name, script, args, cwd) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  children.set(name, child)
  pipe(name, child)
  child.on('exit', (code) => {
    children.delete(name)
    if (stopping) return
    // One half of the pair is gone; leaving the other running is how people end
    // up with a manager nobody remembers starting.
    console.error(`[${name}] exited (code ${code}). Stopping the other process.`)
    shutdown(code ?? 1)
  })
  return child
}

/**
 * Stop the manager the way it wants to be stopped: over its own API first, so
 * it can stop llama-server through the child handle it owns.
 */
async function stopManager(child) {
  try {
    const res = await fetch(`${MANAGER}/api/stop`, {
      method: 'POST',
      headers: { 'X-Hearth': '1' },
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) return
  } catch {
    // Not answering, or already going down. The kill below is the backstop.
  }
  child.kill()
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  const manager = children.get('manager')
  const app = children.get('app')
  if (manager) await stopManager(manager).catch(() => {})
  if (app) app.kill()
  // Give the manager a moment to release both ports before the shell returns.
  await new Promise((r) => setTimeout(r, 600))
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// --- the app -----------------------------------------------------------------

const viteBin = join(APP, 'node_modules', 'vite', 'bin', 'vite.js')
if (!existsSync(viteBin)) {
  console.error(
    'app dependencies are not installed.\n' +
      'Run `npm install` at the repository root (it installs app/ as well), then `npm start` again.',
  )
  process.exit(1)
}

// --- start -------------------------------------------------------------------

console.log('Hearth')

let started = 0

if (await probe(`${MANAGER}/api/status`, { 'X-Hearth': '1' }) !== null) {
  console.log(`  manager  ${MANAGER} — already running, reusing it`)
} else {
  start('manager', join(ROOT, 'server', 'index.mjs'), [], ROOT)
  started++
  const ready = await waitFor(`${MANAGER}/api/status`, { 'X-Hearth': '1' })
  console.log(`  manager  ${MANAGER}${ready ? '' : ' — did not answer in 15 s, see the log'}`)
}

if ((await probe(`${APP_URL}/`)) !== null) {
  console.log(`  app      ${APP_URL} — already running, reusing it`)
} else {
  start('app', viteBin, ['--port', '5173'], APP)
  started++
  const ready = await waitFor(`${APP_URL}/`)
  console.log(`  app      ${APP_URL}${ready ? '' : ' — did not answer in 15 s, see the log'}`)
}

if (!started) {
  console.log('\nBoth were already running; nothing started, nothing to stop.')
  process.exit(0)
}

console.log('\nOpen ' + APP_URL + ' — Ctrl+C stops both.')
