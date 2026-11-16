// Rendering-time tidying. The stored message is never touched; only what is put
// on screen. These cases are the two faults that produced the function.

import { describe, expect, it } from 'vitest'
import { tidy } from './text'

describe('tidy', () => {
  it('collapses three or more newlines to one blank line', () => {
    expect(tidy('one\n\n\n\ntwo')).toBe('one\n\ntwo')
    expect(tidy('one\n\ntwo')).toBe('one\n\ntwo')
  })

  it('leaves a single newline alone', () => {
    expect(tidy('one\ntwo')).toBe('one\ntwo')
  })

  it('does not touch newlines inside a fenced block', () => {
    const src = 'before\n\n\n```\na\n\n\n\nb\n```\n\n\nafter'
    const out = tidy(src)
    expect(out).toContain('```\na\n\n\n\nb\n```')
    // …while the padding outside the fence is still collapsed.
    expect(out).toBe('before\n\n```\na\n\n\n\nb\n```\n\nafter')
  })

  it('handles more than one fenced block without shifting which parts are code', () => {
    const src = 'a\n\n\n```\nx\n\n\ny\n```\n\n\nmid\n\n\n```\nz\n\n\nw\n```\n\n\nend'
    expect(tidy(src)).toBe('a\n\n```\nx\n\n\ny\n```\n\nmid\n\n```\nz\n\n\nw\n```\n\nend')
  })

  it('is a no-op on text that is already tidy', () => {
    const src = 'one\n\ntwo\n\n```\ncode\n```'
    expect(tidy(src)).toBe(src)
  })
})
