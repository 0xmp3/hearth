// The reply-budget slider moves over these stops, because a linear range from
// 256 to 1M is unusable: almost the whole travel sits in the top few percent.

import { describe, expect, it } from 'vitest'
import { BUDGET_STOPS, formatTokens, nearestStopIndex } from './budget'

describe('nearestStopIndex', () => {
  it('finds an exact stop', () => {
    expect(BUDGET_STOPS[nearestStopIndex(2048)]).toBe(2048)
  })

  it('rounds to the nearest stop, not the next one up', () => {
    expect(BUDGET_STOPS[nearestStopIndex(2000)]).toBe(2048)
    expect(BUDGET_STOPS[nearestStopIndex(300)]).toBe(256)
    expect(BUDGET_STOPS[nearestStopIndex(700)]).toBe(512)
  })

  it('clamps outside the range', () => {
    expect(BUDGET_STOPS[nearestStopIndex(1)]).toBe(256)
    expect(BUDGET_STOPS[nearestStopIndex(10_000_000)]).toBe(1048576)
  })
})

describe('formatTokens', () => {
  it('shows small budgets as they are', () => {
    expect(formatTokens(256)).toBe('256')
  })

  it('uses k above a thousand, and drops a pointless .0', () => {
    expect(formatTokens(1024)).toBe('1k')
    expect(formatTokens(2048)).toBe('2k')
    expect(formatTokens(1500)).toBe('1.5k')
    // One decimal, so a power-of-two stop reads honestly rather than as a
    // rounded-down "262k".
    expect(formatTokens(262144)).toBe('262.1k')
  })

  it('uses M at a million', () => {
    expect(formatTokens(1048576)).toBe('1M')
    expect(formatTokens(1572864)).toBe('1.5M')
  })
})
