// Where things live.
//
// Nothing in this app hardcodes a path on someone's disk. The engine and the
// models folder are resolved in a fixed order, and every source is something
// the user can see and change:
//
//   1. HEARTH_LLAMA / HEARTH_MODELS   environment, for scripts and CI
//   2. data/config.json               the app's own settings, editable in the UI
//   3. data/engine/                   a build this app downloaded itself
//
// If none of them resolve, the answer is "no engine" — not a guess at a path
// that happens to exist on the developer's machine.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const BIN = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

/**
 * Written by the installer after a complete, verified extract. A managed build is
 * only "installed" when this exists — a truncated .exe from a killed extract is
 * not, and used to pass for one.
 */
export const MARKER = '.installed.json'

const DEFAULTS = {
  enginePath: null,
  modelsDir: null,
  ctx: 16384,
  ngl: 99,
  // Loopback by default. Set to 0.0.0.0 (or a host-only adapter address) only
  // when something outside this machine needs the model — a test VM, say — and
  // scope the firewall rule to that subnet at the same time.
  bindHost: '127.0.0.1',
  // Egress is off until the user says otherwise, and it is the manager that
  // enforces it: the app asks, the manager decides.
  network: false,
  // The backend proxy only accepts a loopback address. Turn this on to allow a
  // backend on another machine (a test VM, a box on the LAN) — and understand
  // that it hands the app a general POST primitive to that host.
  allowRemoteBackend: false,
}

export function configPath(dataDir) {
  return join(dataDir, 'config.json')
}

export function readConfig(dataDir) {
  try {
    const raw = readFileSync(configPath(dataDir), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeConfig(dataDir, patch) {
  const next = { ...readConfig(dataDir), ...patch }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(configPath(dataDir), JSON.stringify(next, null, 2) + '\n')
  return next
}

/**
 * Resolve the engine binary. `source` says where the answer came from, so the
 * UI can explain it instead of just showing a path.
 */
export function resolveEngine(dataDir) {
  const env = process.env.HEARTH_LLAMA
  if (env) return { path: env, source: 'env', exists: existsSync(env) }

  const cfg = readConfig(dataDir)
  if (cfg.enginePath) {
    return { path: cfg.enginePath, source: 'config', exists: existsSync(cfg.enginePath) }
  }

  const managed = join(dataDir, 'engine', BIN)
  // Resolving a path and *claiming* an install are different questions. The
  // marker (see MARKER) is what the engine panel reports as installed; an
  // existing binary must still resolve, because everyone who installed before
  // v1.44 has one and would otherwise lose their engine on upgrade.
  if (existsSync(managed)) return { path: managed, source: 'managed', exists: true }

  return { path: null, source: 'none', exists: false }
}

export function resolveModelsDir(dataDir) {
  const env = process.env.HEARTH_MODELS
  if (env) return { path: env, source: 'env', exists: existsSync(env) }

  const cfg = readConfig(dataDir)
  if (cfg.modelsDir) {
    return { path: cfg.modelsDir, source: 'config', exists: existsSync(cfg.modelsDir) }
  }

  return { path: null, source: 'none', exists: false }
}

export function engineDir(dataDir) {
  return join(dataDir, 'engine')
}
