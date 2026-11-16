// The duplicate-fact threshold. 0.7 is a measurement, not a taste: on a live
// roleplay the two real duplicates scored 0.90 and 0.75, and the closest pair of
// genuinely different facts scored 0.33. These cases sit on either side of it so
// that moving the number breaks something.

import { describe, expect, it } from 'vitest'
import { NO_TOOLS, sameText, toolGuidance, toolsFor } from './tools'

const words10 = (n: number, shared: number) => {
  const pool = ['ferry', 'leaves', 'six', 'inn', 'heron', 'town', 'weather', 'captain', 'river', 'morning', 'market', 'harbour']
  return { a: pool.slice(0, n).join(' '), b: [...pool.slice(0, shared), ...pool.slice(n, n + (n - shared))].join(' ') }
}

describe('sameText', () => {
  it('matches identical text, ignoring case and spacing', () => {
    expect(sameText('The ferry leaves at six.', 'the ferry leaves at six')).toBe(true)
    expect(sameText('  heron inn  ', 'heron inn')).toBe(true)
  })

  it('matches a rephrasing that shares most of its words', () => {
    // 9 of 10 words shared → 0.818, the range the real duplicates landed in.
    const { a, b } = words10(10, 9)
    expect(sameText(a, b)).toBe(true)
  })

  it('refuses a pair that shares 8 of 10 — 0.667, below the line', () => {
    const { a, b } = words10(10, 8)
    expect(sameText(a, b)).toBe(false)
  })

  it('refuses the measured "different facts" score', () => {
    // 1 of 3 → 0.333, which is what a genuinely different fact scored.
    expect(sameText('ferry leaves', 'ferry inn')).toBe(false)
  })

  it('ignores filler, so padding cannot push a pair over the line', () => {
    expect(sameText('the ferry leaves at six', 'ferry leaves six')).toBe(true)
    expect(sameText('there is a setting that has the weather', 'weather')).toBe(true)
  })

  it('does not treat two unrelated single words as the same fact', () => {
    expect(sameText('ferry', 'inn')).toBe(false)
  })

  it('ignores punctuation', () => {
    expect(sameText('The ferry, at six.', 'the ferry at six')).toBe(true)
  })
})

describe('tool policy', () => {
  it('declares nothing when every switch is off', () => {
    expect(toolsFor(NO_TOOLS)).toEqual([])
    expect(toolGuidance(NO_TOOLS)).toBe('')
  })

  it('states the repeat-call rule only when a tool that can repeat is declared', () => {
    const withFiles = toolsFor({ ...NO_TOOLS, list_files: true }).map((t) => t.name)
    expect(withFiles).toContain('list_files')
    expect(withFiles).not.toContain('web_search')
  })
})
