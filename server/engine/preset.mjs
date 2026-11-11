// Router mode needs a preset file to give a model a vision projector.
//
// `--models-dir` discovers models but has no way to say "this one also has an
// mmproj beside it" — a file named mmproj-<model>.gguf is ignored. The preset
// INI is the supported way to attach one, so the manager generates it from the
// models folder on every start.
//
// Format, per llama.cpp's server docs:
//
//   [model-name]
//   model = /path/to/model.gguf
//   mmproj = /path/to/mmproj-model.gguf
//   c = 16384
//   n-gpu-layers = 99
//   jinja = true

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MMPROJ = /^mmproj[-_]/i

/** Forward slashes: the INI is read by a C++ parser that treats \ as an escape. */
function p(path) {
  return path.replace(/\\/g, '/')
}

export function buildPreset(modelsDir, presetPath, { ctx, ngl } = {}) {
  const files = readdirSync(modelsDir).filter((f) => f.toLowerCase().endsWith('.gguf'))
  const projectors = files.filter((f) => MMPROJ.test(f))
  const models = files.filter((f) => !MMPROJ.test(f))

  const sections = []
  const withVision = []

  for (const file of models) {
    const name = basename(file, '.gguf')
    // The convention is mmproj-<model>.gguf. Anything else is left alone rather
    // than guessed at — a wrong projector is worse than none.
    const projector = projectors.find(
      (m) => m.toLowerCase() === `mmproj-${name}.gguf`.toLowerCase(),
    )

    const lines = [`[${name}]`, `model = ${p(join(modelsDir, file))}`]
    if (projector) {
      lines.push(`mmproj = ${p(join(modelsDir, projector))}`)
      withVision.push(name)
    }
    if (ctx) lines.push(`c = ${ctx}`)
    if (ngl != null) lines.push(`n-gpu-layers = ${ngl}`)
    lines.push('jinja = true')

    sections.push(lines.join('\n'))
  }

  mkdirSync(dirname(presetPath), { recursive: true })
  writeFileSync(presetPath, sections.join('\n\n') + '\n')

  return {
    path: presetPath,
    models: models.map((m) => basename(m, '.gguf')),
    withVision,
  }
}
