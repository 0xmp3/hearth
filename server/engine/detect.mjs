// What machine are we on, and what GPU does it have?
//
// Every probe is best-effort. A failure means "unknown", never a crash — the
// caller decides what to do with an unknown GPU, and the answer is usually
// "fall back to the build that runs anywhere".

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const VENDORS = [
  [/nvidia|geforce|quadro|tesla|\brtx\b/i, 'nvidia'],
  [/amd|radeon|instinct|firepro/i, 'amd'],
  [/intel|\barc\b|iris|uhd graphics|hd graphics/i, 'intel'],
  [/apple|\bm[1-9]\b/i, 'apple'],
]

export function vendorOf(name) {
  for (const [re, vendor] of VENDORS) if (re.test(name)) return vendor
  return 'unknown'
}

// Integrated GPUs are listed alongside discrete ones, and we want the discrete
// card. These names are the ones that show up as "also present" on laptops and
// APUs; anything else is assumed to be the card worth using.
const INTEGRATED = /radeon\(tm\) graphics|vega \d+ graphics|uhd graphics|hd graphics|iris|adreno|microsoft basic/i

function rank(gpu) {
  if (INTEGRATED.test(gpu.name)) return 0
  if (gpu.vendor === 'nvidia' || gpu.vendor === 'apple') return 3
  if (gpu.vendor === 'amd') return 2
  return 1
}

async function gpuNames() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
        ],
        { timeout: 20000 },
      )
      return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    }

    if (process.platform === 'darwin') {
      const { stdout } = await run('system_profiler', ['SPDisplaysDataType'], { timeout: 20000 })
      return stdout
        .split(/\r?\n/)
        .map((line) => line.match(/Chipset Model:\s*(.+)/)?.[1]?.trim())
        .filter(Boolean)
    }

    // Linux: lspci is the common case, /sys is the fallback when it is absent.
    const { stdout } = await run(
      'sh',
      ['-c', "lspci 2>/dev/null | grep -iE 'vga|3d|display' || true"],
      { timeout: 10000 },
    )
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function detect() {
  const names = await gpuNames()
  const gpus = names
    .map((name) => ({ name, vendor: vendorOf(name) }))
    .sort((a, b) => rank(b) - rank(a))

  return {
    os: process.platform,
    arch: process.arch,
    gpu: gpus[0] ?? { name: 'unknown', vendor: 'unknown' },
    allGpus: gpus,
  }
}
