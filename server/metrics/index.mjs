// System metrics.
//
// Two very different costs live here, so they are sampled differently:
//
//   CPU / RAM / disk  come from Node itself. Free, so they are read on demand.
//   GPU               needs Windows performance counters, which cost ~2 s per
//                     sample because a rate counter needs two readings. That
//                     runs in one long-lived PowerShell process instead of a
//                     fresh one per poll.
//
// Nothing samples unless someone asked for it. `start()` is called when the
// strip is enabled and `stop()` when it is turned off, so an idle app costs
// nothing.

import { spawn } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GPU_SCRIPT = join(HERE, 'gpu.ps1')

let gpuProcess = null
let gpu = null
let gpuError = null
let buffer = ''

// CPU percentage needs a delta between two readings of the cumulative counters.
let lastCpu = null

function readCpu() {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

function cpuPercent() {
  const now = readCpu()
  if (!lastCpu) {
    lastCpu = now
    return null
  }
  const idleDelta = now.idle - lastCpu.idle
  const totalDelta = now.total - lastCpu.total
  lastCpu = now
  if (totalDelta <= 0) return null
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10
}

function startGpu() {
  if (gpuProcess || process.platform !== 'win32') return

  gpuError = null
  // Absolute, because a `powershell.exe` earlier in PATH is whatever that file
  // happens to be, running with this process's token.
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  gpuProcess = spawn(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      GPU_SCRIPT,
      '-ParentPid',
      String(process.pid),
    ],
    { windowsHide: true },
  )

  gpuProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.error) gpuError = parsed.error
        else {
          gpu = parsed
          gpuError = null
        }
      } catch {
        // A partial or unexpected line is not worth failing over.
      }
    }
  })

  gpuProcess.on('exit', () => {
    gpuProcess = null
    gpu = null
  })

  gpuProcess.on('error', (err) => {
    gpuError = err.message
    gpuProcess = null
  })
}

function stopGpu() {
  if (!gpuProcess) return
  gpuProcess.kill()
  gpuProcess = null
  gpu = null
  buffer = ''
}

export function start() {
  startGpu()
  lastCpu = readCpu()
}

export function stop() {
  stopGpu()
  lastCpu = null
}

export function running() {
  return Boolean(gpuProcess)
}

/**
 * A snapshot of the machine. `diskPath` decides which volume the free-space
 * figure describes — the one the models live on, not the one the app lives on.
 */
export async function snapshot(diskPath) {
  const total = totalmem()
  const free = freemem()

  let disk = null
  if (diskPath) {
    try {
      const s = await statfs(diskPath)
      disk = {
        freeGb: Math.round((s.bavail * s.bsize) / 1073741824 * 10) / 10,
        totalGb: Math.round((s.blocks * s.bsize) / 1073741824 * 10) / 10,
      }
    } catch {
      disk = null
    }
  }

  return {
    at: Date.now(),
    cpu: { percent: cpuPercent(), cores: cpus().length },
    ram: {
      usedGb: Math.round(((total - free) / 1073741824) * 10) / 10,
      totalGb: Math.round((total / 1073741824) * 10) / 10,
    },
    gpu: gpu
      ? { util: gpu.util, vramUsedGb: gpu.vramUsed, vramTotalGb: gpu.vramTotal }
      : null,
    gpuError: process.platform === 'win32' ? gpuError : 'not supported on this platform',
    disk,
  }
}
