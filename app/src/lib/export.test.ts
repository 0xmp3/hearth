// The import path, from the app's side.
//
// `parseBackup()` is the only validator a normal import meets — the manager used
// to trust whatever it was handed, so this function failing open would put junk
// straight into the user's library. Every refusal here is a case where importing
// would have been worse than saying no.

import { describe, expect, it } from 'vitest'
import { parseBackup } from './export'

const conv = { id: 'c1', title: 'A chat', createdAt: 1, updatedAt: 1, model: 'm' }
const msg = { id: 'm1', conversationId: 'c1', role: 'user', content: 'hello', createdAt: 1 }

const backup = (over: Record<string, unknown> = {}) => ({
  format: 'hearth-backup',
  version: 5,
  exportedAt: new Date().toISOString(),
  conversations: [conv],
  messages: [msg],
  characters: [],
  prompts: [],
  memories: [],
  profiles: [],
  ...over,
})

const text = (over: Record<string, unknown> = {}) => JSON.stringify(backup(over))

describe('parseBackup', () => {
  it('accepts a current backup', () => {
    const out = parseBackup(text())
    expect(out.conversations).toHaveLength(1)
    expect(out.messages).toHaveLength(1)
  })

  it('accepts an old backup that predates characters and prompts', () => {
    const old = backup({ version: 1 })
    delete (old as Record<string, unknown>).characters
    delete (old as Record<string, unknown>).prompts
    const out = parseBackup(JSON.stringify(old))
    expect(out.characters).toEqual([])
    expect(out.prompts).toEqual([])
  })

  it('refuses text that is not JSON', () => {
    expect(() => parseBackup('this is not json')).toThrow(/not valid JSON/)
  })

  it('refuses a JSON file that is not a backup', () => {
    expect(() => parseBackup(JSON.stringify({ hello: 'world' }))).toThrow(/not a Hearth backup/)
  })

  it('refuses a version it does not understand, in both directions', () => {
    expect(() => parseBackup(text({ version: 99 }))).toThrow(/unsupported backup version/)
    expect(() => parseBackup(text({ version: 0 }))).toThrow(/unsupported backup version/)
    expect(() => parseBackup(text({ version: '5' }))).toThrow(/unsupported backup version/)
  })

  it('refuses a backup with no conversations or messages array', () => {
    expect(() => parseBackup(text({ conversations: undefined }))).toThrow(/missing conversations or messages/)
    expect(() => parseBackup(text({ messages: undefined }))).toThrow(/missing conversations or messages/)
  })

  it('refuses a malformed conversation rather than half-restoring it', () => {
    expect(() => parseBackup(text({ conversations: [{ id: 'c1' }] }))).toThrow(/conversation .* malformed/)
    expect(() => parseBackup(text({ conversations: [null] }))).toThrow(/conversation .* malformed/)
  })

  it('refuses a malformed message', () => {
    expect(() => parseBackup(text({ messages: [{ id: 'm1', conversationId: 'c1' }] }))).toThrow(/message .* malformed/)
    expect(() => parseBackup(text({ messages: [{ id: 'm1', content: 'x' }] }))).toThrow(/message .* malformed/)
  })
})
