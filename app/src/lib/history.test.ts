// The request, assembled. This is the seam where three separate bugs lived:
// the stack order, the character resolved twice (prompt applied, memory owner
// lost), and empty assistant turns being sent as if they were answers.

import { describe, expect, it } from 'vitest'
import type * as db from './db'
import type { ChatMessage } from './stream'
import { buildHistory, sendableTurns, systemStack } from './history'
import { NO_TOOLS } from './tools'

const NOW = Date.UTC(2026, 10, 16)

function conv(over: Partial<db.Conversation> = {}): db.Conversation {
  return { id: 'c1', title: 'A chat', createdAt: NOW, updatedAt: NOW, model: 'm', ...over }
}

function msg(id: string, role: 'user' | 'assistant', content: string, over: Partial<db.Message> = {}): db.Message {
  return { id, conversationId: 'c1', role, content, createdAt: NOW, ...over }
}

function memory(over: Partial<db.Memory>): db.Memory {
  return { id: `m-${Math.random()}`, text: 'a fact', scope: 'conversation', ownerId: 'c1', createdAt: NOW, updatedAt: NOW, ...over }
}

/** Stands in for the browser's attachment handling, which is not under test here. */
const plain = async (m: db.Message): Promise<ChatMessage> => ({ role: m.role, content: m.content })

const baseCtx = {
  memories: [] as db.Memory[],
  character: null,
  profile: null,
  date: 'Today is 16 November 2026.',
  policy: NO_TOOLS,
  defaultPrompt: 'You are Hearth.',
}

describe('systemStack', () => {
  it('puts the parts in the documented order', () => {
    const out = systemStack({
      ...baseCtx,
      profile: { description: 'the profile' },
      character: { id: 'elara', systemPrompt: 'the character' },
      summaryBlock: 'the summary',
      memoryBlock: 'the memory',
      policy: { ...NO_TOOLS, remember: true },
      conversationPrompt: 'the conversation',
      defaultPrompt: 'the default',
    })
    const order = ['16 November 2026', 'the profile', 'the character', 'the summary', 'the memory', 'the conversation']
    const positions = order.map((needle) => out.indexOf(needle))
    positions.forEach((at) => expect(at).toBeGreaterThan(-1))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // The default prompt is replaced, not appended, when the chat has its own.
    expect(out).not.toContain('the default')
  })

  it('falls back to the default prompt when the conversation has none', () => {
    expect(systemStack(baseCtx)).toContain('You are Hearth.')
    expect(systemStack({ ...baseCtx, conversationPrompt: '   ' })).toContain('You are Hearth.')
  })

  it('keeps the date first, because it frames everything after it', () => {
    const out = systemStack({ ...baseCtx, profile: { description: 'the profile' } })
    expect(out.startsWith('Today is 16 November 2026.')).toBe(true)
  })

  it('is empty when nothing is set — and then no system message is sent', async () => {
    expect(systemStack({ ...baseCtx, date: '', defaultPrompt: '' })).toBe('')
    const out = await buildHistory([msg('m1', 'user', 'hello')], conv(), { ...baseCtx, date: '', defaultPrompt: '' }, plain)
    expect(out[0].role).toBe('user')
  })
})

describe('buildHistory', () => {
  it('sends one system message first, then the turns', async () => {
    const out = await buildHistory(
      [msg('m1', 'user', 'hello'), msg('m2', 'assistant', 'hi')],
      conv(),
      baseCtx,
      plain,
    )
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('injects a character fact when the conversation inherits the character', async () => {
    // The bug this pins: the conversation stores `characterId: undefined`
    // ("inherit"), the prompt resolves fine, and the memory owner used to be
    // `undefined ?? null` — null — so the fact was saved, listed and never sent.
    const inherited = conv({ characterId: undefined })
    const out = await buildHistory(
      [msg('m1', 'user', 'hello')],
      inherited,
      {
        ...baseCtx,
        character: { id: 'elara', systemPrompt: 'You are Elara.' },
        memories: [memory({ text: 'Elara fears the river', scope: 'character', ownerId: 'elara' })],
      },
      plain,
    )
    expect(out[0].content).toContain('You are Elara.')
    expect(out[0].content).toContain('Elara fears the river')
  })

  it("does not inject another character's facts", async () => {
    const out = await buildHistory(
      [msg('m1', 'user', 'hello')],
      conv({ characterId: 'cormac' }),
      {
        ...baseCtx,
        character: { id: 'cormac', systemPrompt: 'You are Cormac.' },
        memories: [
          memory({ text: 'Elara fears the river', scope: 'character', ownerId: 'elara' }),
          memory({ text: 'Cormac keeps a ledger', scope: 'character', ownerId: 'cormac' }),
        ],
      },
      plain,
    )
    expect(out[0].content).toContain('Cormac keeps a ledger')
    expect(out[0].content).not.toContain('Elara fears the river')
  })

  it('sends only the turns a summary does not already cover', async () => {
    const messages = [msg('a', 'user', 'one'), msg('b', 'assistant', 'two'), msg('c', 'user', 'three')]
    const summary = memory({ text: 'They counted to two', kind: 'summary', throughMessageId: 'b', messageCount: 2 })
    const out = await buildHistory(messages, conv(), { ...baseCtx, memories: [summary] }, plain)
    expect(out.map((m) => m.content)).toContain('three')
    expect(out.map((m) => m.content)).not.toContain('one')
    expect(out[0].content).toContain('They counted to two')
  })

  it('drops an assistant turn that produced no text', async () => {
    const out = await buildHistory(
      [msg('m1', 'user', 'hello'), msg('m2', 'assistant', '   '), msg('m3', 'user', 'are you there?')],
      conv(),
      baseCtx,
      plain,
    )
    expect(out.map((m) => m.content)).not.toContain('   ')
    expect(out).toHaveLength(3) // system + two real turns
  })

  it('keeps a turn that carries only an attachment', async () => {
    const withFile = msg('m2', 'user', '', { attachments: [{ kind: 'text', name: 'a.txt', text: 'body' }] as never })
    expect(sendableTurns([withFile], null)).toHaveLength(1)
  })

  it('never sends the summary as a memory fact as well', async () => {
    const summary = memory({ text: 'They counted to two', kind: 'summary', throughMessageId: 'b' })
    const out = await buildHistory([msg('a', 'user', 'one'), msg('b', 'assistant', 'two')], conv(), {
      ...baseCtx,
      memories: [summary],
    }, plain)
    expect((out[0].content as string).split('They counted to two')).toHaveLength(2) // exactly once
  })
})
