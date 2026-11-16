// A theme file is user input, so it is checked before it is trusted. The rule
// that matters: a bad file is refused whole. A half-applied theme is a broken
// app with no explanation, and it looks exactly like a bug in the app.

import { describe, expect, it } from 'vitest'
import { validateTheme } from './validate'

const COLORS = {
  bg: '#111111',
  field: '#191919',
  desktop: '#0b0b0b',
  panel: '#151515',
  raised: '#1d1d1d',
  text: '#eeeeee',
  muted: '#999999',
  faint: '#666666',
  accent: '#c98b4b',
  onAccent: '#111111',
  border: '#2a2a2a',
  danger: '#c0563f',
  warn: '#c9a24b',
  syntaxKeyword: '#c98b4b',
  syntaxString: '#7fa96b',
  syntaxNumber: '#b48ead',
  syntaxTitle: '#d4a35f',
  syntaxComment: '#6b6b6b',
}

const valid = { id: 'hearth-98', name: 'Hearth 98', scheme: 'light', colors: COLORS }

describe('validateTheme', () => {
  it('accepts a complete theme', () => {
    const out = validateTheme(valid)
    expect(out.ok).toBe(true)
  })

  it('accepts an optional chrome and optional extras', () => {
    const out = validateTheme({ ...valid, chrome: 'win95', density: 1.1, fonts: { body: 'Georgia' } })
    expect(out.ok).toBe(true)
  })

  it('refuses anything that is not an object', () => {
    for (const bad of [null, 42, 'theme', [valid]]) {
      expect(validateTheme(bad).ok).toBe(false)
    }
  })

  it('names the missing field it refuses', () => {
    const cases: [unknown, string][] = [
      [{ ...valid, id: undefined }, 'missing "id"'],
      [{ ...valid, name: '' }, 'missing "name"'],
      [{ ...valid, scheme: 'grey' }, '"scheme"'],
      [{ ...valid, chrome: 'win98' }, '"chrome"'],
      [{ ...valid, colors: undefined }, 'missing "colors"'],
    ]
    for (const [input, reason] of cases) {
      const out = validateTheme(input)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain(reason)
    }
  })

  it('refuses an id that would break a file name or a selector', () => {
    const out = validateTheme({ ...valid, id: 'Hearth 98!' })
    expect(out.ok).toBe(false)
  })

  it('refuses a theme missing one colour, and names it', () => {
    const { accent: _drop, ...withoutAccent } = COLORS
    const out = validateTheme({ ...valid, colors: withoutAccent })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('accent')
  })

  it('refuses a density outside the usable range', () => {
    expect(validateTheme({ ...valid, density: 0.4 }).ok).toBe(false)
    expect(validateTheme({ ...valid, density: 2 }).ok).toBe(false)
    expect(validateTheme({ ...valid, density: Number.NaN }).ok).toBe(false)
  })

  it('refuses a font or chrome variable that is not a string', () => {
    expect(validateTheme({ ...valid, fonts: { body: 12 } }).ok).toBe(false)
    expect(validateTheme({ ...valid, chromeVars: { titleBar: 0 } }).ok).toBe(false)
  })
})
