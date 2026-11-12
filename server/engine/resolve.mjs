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

const DEFAULTS = {
  enginePath: null,
  modelsDir: null,
  ctx: 16384,
  ngl: 99,
  // Egress is off until the user says otherwise, and it is the manager that
  // enforces it: the app asks, the manager decides.
  network: false,
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
