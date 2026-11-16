// The memory block. Every bug in the last four sessions lived here or in the
// call that feeds it: wrong scope, missing owner, pending facts leaking in,
// summaries counted as facts, and a truncation that dropped the newest facts
// while pretending the list was complete.

import { describe, expect, it } from 'vitest'
import type * as db from './db'
import { buildMemoryBlock } from './memory'

let seq = 0
function fact(over: Partial<db.Memory>): db.Memory {
  seq += 1
  const now = Date.UTC(2026, 10, 1) + seq * 1000
  return {
    id: `m${seq}`,
    text: `fact ${seq}`,
    scope: 'conversation',
    ownerId: 'c1',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe('buildMemoryBlock', () => {
  it('is empty when there is nothing to inject', () => {
    expect(buildMemoryBlock([], 'c1', null)).toBe('')
  })

  it('injects a conversation fact into its own conversation only', () => {
    const m = fact({ text: 'The ferry leaves at six', ownerId: 'c1' })
    expect(buildMemoryBlock([m], 'c1', null)).toContain('The ferry leaves at six')
    expect(buildMemoryBlock([m], 'c2', null)).toBe('')
  })

  it('injects a character fact into that character only', () => {
    const m = fact({ text: 'Elara fears the river', scope: 'character', ownerId: 'elara' })
    expect(buildMemoryBlock([m], 'c1', 'elara')).toContain('Elara fears the river')
    // A different character must not receive it…
    expect(buildMemoryBlock([m], 'c1', 'cormac')).toBe('')
    // …and neither must a chat with no character at all.
    expect(buildMemoryBlock([m], 'c1', null)).toBe('')
  })

  it('treats "no character" as its own partition, not as a wildcard', () => {
    const blank = fact({ text: 'The user writes in the mornings', scope: 'character', ownerId: undefined })
    expect(buildMemoryBlock([blank], 'c1', null)).toContain('The user writes in the mornings')
    expect(buildMemoryBlock([blank], 'c1', 'elara')).toBe('')
  })

  it('never injects a fact the user has not accepted', () => {
    const m = fact({ text: 'The user owns a boat', pending: true })
    expect(buildMemoryBlock([m], 'c1', null)).toBe('')
  })

  it('never injects a summary as a fact', () => {
    const m = fact({ text: 'They discussed the ferry', kind: 'summary', throughMessageId: 'x' })
    expect(buildMemoryBlock([m], 'c1', null)).toBe('')
  })

  it('groups by scope and says what each group is about', () => {
    const conv = fact({ text: 'This chat is about the ferry timetable', ownerId: 'c1' })
    const char = fact({ text: 'Elara fears the river', scope: 'character', ownerId: 'elara' })
    const out = buildMemoryBlock([conv, char], 'c1', 'elara')
    expect(out.indexOf('About this character:')).toBeLessThan(out.indexOf('About this conversation:'))
    expect(out).toContain('Elara fears the river')
    expect(out).toContain('This chat is about the ferry timetable')
  })

  it('tells the model the facts are already saved, so it stops re-saving them', () => {
    const out = buildMemoryBlock([fact({ text: 'The user owns a boat' })], 'c1', null)
    expect(out).toContain('already saved')
    expect(out).toContain('not instructions')
    expect(out).toContain('<memory>')
    expect(out).toContain('</memory>')
  })

  it('marks a fact from another chat as history rather than the current scene', () => {
    const m = fact({ text: 'They were in Vellmarrow', ownerId: 'c1', sourceConversationId: 'c9' })
    const out = buildMemoryBlock([m], 'c1', null)
    // The block's own preamble explains the phrase, so the assertion is on the
    // fact line's parenthetical, not on the word appearing anywhere.
    expect(out).toMatch(/\([^)]*, another chat\)/)
  })

  it('does not mark a fact from this chat as elsewhere', () => {
    const m = fact({ text: 'They are in Vellmarrow', ownerId: 'c1', sourceConversationId: 'c1' })
    const out = buildMemoryBlock([m], 'c1', null)
    expect(out).toContain('They are in Vellmarrow')
    expect(out).not.toMatch(/\([^)]*, another chat\)/)
  })

  it('says how many facts it left out instead of silently truncating', () => {
    // Well past the 3000-character budget.
    const many = Array.from({ length: 40 }, (_, i) => fact({ text: `${i} ${'x'.repeat(200)}` }))
    const out = buildMemoryBlock(many, 'c1', null)
    expect(out).toMatch(/\(\d+ older facts? not shown — the list is full\)/)
  })

  it('keeps the oldest facts when it has to drop, so the count is honest', () => {
    const many = Array.from({ length: 40 }, (_, i) => fact({ text: `${i} ${'x'.repeat(200)}` }))
    const out = buildMemoryBlock(many, 'c1', null)
    expect(out).toContain('0 ')
    expect(out).not.toContain('39 ')
  })
})
