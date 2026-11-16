// Chunking and hashing: the two decisions that decide whether the index can be
// trusted. A chunk that changes shape re-embeds the world; a hash that ignores
// an edit leaves a stale vector scoring against text that no longer exists.

import { describe, expect, it } from 'vitest'
import { chunkText, hashText } from './vectors'

describe('chunkText', () => {
  it('drops empty and whitespace-only messages', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('keeps a short message whole', () => {
    expect(chunkText('The ferry runs at six.')).toEqual(['The ferry runs at six.'])
  })

  it('joins paragraphs into one chunk while they fit', () => {
    expect(chunkText('one\n\ntwo\n\nthree')).toEqual(['one\n\ntwo\n\nthree'])
  })

  it('splits on paragraph breaks once the budget is passed', () => {
    const a = 'a'.repeat(60)
    const b = 'b'.repeat(60)
    const out = chunkText(`${a}\n\n${b}`, 100)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('never returns a chunk far over the budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const out = chunkText(long, 200)
    expect(out.length).toBeGreaterThan(1)
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(200)
    // Nothing is lost in the split.
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '))
  })

  it('prefers a sentence break over a hard cut', () => {
    const text = `${'x'.repeat(80)}. ${'y'.repeat(120)}`
    const [first] = chunkText(text, 100)
    expect(first.endsWith('.')).toBe(true)
  })
})

describe('hashText', () => {
  it('is stable for the same text', () => {
    expect(hashText('same text')).toBe(hashText('same text'))
  })

  it('changes when the text changes', () => {
    expect(hashText('one')).not.toBe(hashText('two'))
    expect(hashText('one')).not.toBe(hashText('one '))
  })

  it('carries the length, so a collision has to be the same size too', () => {
    expect(hashText('abc')).toMatch(/^[0-9a-f]{8}:3$/)
  })

  it('does not confuse an edit that keeps the length', () => {
    expect(hashText('abc')).not.toBe(hashText('abd'))
  })
})
