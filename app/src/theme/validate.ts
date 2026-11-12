// Validating a theme that came from a file.
//
// A theme file is user input, so it is checked before it is trusted. A bad file
// is reported and skipped — it must never take the app down or half-apply,
// because a half-applied theme is a broken-looking app with no explanation.

import type { Theme, ThemeColors } from './types'

const REQUIRED_COLORS = [
  'bg',
  'field',
  'desktop',
  'panel',
  'raised',
  'text',
  'muted',
  'faint',
  'accent',
  'onAccent',
  'border',
  'danger',
  'warn',
  'syntaxKeyword',
  'syntaxString',
  'syntaxNumber',
  'syntaxTitle',
  'syntaxComment',
] as const

// Compile-time guard: if a colour is added to ThemeColors and not to the list
// above, this stops being `true` and the build fails. The list cannot drift.
type Missing = Exclude<keyof ThemeColors, (typeof REQUIRED_COLORS)[number]>
const _coversEveryColour: Missing extends never ? true : never = true
void _coversEveryColour

export type ThemeResult =
  | { ok: true; theme: Theme }
  | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function validateTheme(input: unknown): ThemeResult {
  if (!isRecord(input)) return { ok: false, reason: 'not a JSON object' }

  if (!nonEmpty(input.id)) return { ok: false, reason: 'missing "id"' }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(input.id)) {
    return { ok: false, reason: '"id" must be letters, digits and dashes' }
  }
  if (!nonEmpty(input.name)) return { ok: false, reason: 'missing "name"' }

  if (input.scheme !== 'dark' && input.scheme !== 'light') {
    return { ok: false, reason: '"scheme" must be "dark" or "light"' }
  }

  if (input.chrome !== undefined && input.chrome !== 'flat' && input.chrome !== 'win95') {
    return { ok: false, reason: '"chrome" must be "flat" or "win95"' }
  }

  if (!isRecord(input.colors)) return { ok: false, reason: 'missing "colors"' }
  for (const key of REQUIRED_COLORS) {
    if (!nonEmpty(input.colors[key])) {
      return { ok: false, reason: `missing colour "${key}"` }
    }
  }

  if (input.fonts !== undefined) {
    if (!isRecord(input.fonts)) return { ok: false, reason: '"fonts" must be an object' }
    for (const [k, v] of Object.entries(input.fonts)) {
      if (v !== undefined && typeof v !== 'string') {
        return { ok: false, reason: `font "${k}" must be a string` }
      }
    }
  }

  if (input.chromeVars !== undefined) {
    if (!isRecord(input.chromeVars)) return { ok: false, reason: '"chromeVars" must be an object' }
    for (const [k, v] of Object.entries(input.chromeVars)) {
      if (typeof v !== 'string') {
        return { ok: false, reason: `chromeVars "${k}" must be a string` }
      }
    }
  }

  if (input.density !== undefined) {
    const d = input.density
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0.5 || d > 1.5) {
      return { ok: false, reason: '"density" must be a number between 0.5 and 1.5' }
    }
  }

  return { ok: true, theme: input as unknown as Theme }
}
