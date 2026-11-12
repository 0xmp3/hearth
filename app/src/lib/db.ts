// Persistence. No React, no network — just IndexedDB.
// Two stores: conversations, and messages indexed by conversationId.

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  systemPrompt?: string
  /** Set when pinned; pinned conversations sort above the rest. */
  pinnedAt?: number
  /**
   * The character this conversation speaks as.
   * `undefined` = inherit the globally active profile (older conversations).
   * `null` = explicitly no character.
   */
  personaId?: string | null
}

import type { Attachment } from './attachments'

export type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: number
  aborted?: boolean
  /** The character that produced this reply, so history stays accurate. */
  personaId?: string | null
  /** The budget ran out before any answer was produced. */
  truncated?: boolean
  /** Files sent with this message. Text is inlined; images go as content parts. */
  attachments?: Attachment[]
  /** Tools this reply ran, so the activity is visible and not a black box. */
  tools?: { name: string; ok: boolean; summary: string }[]
  stats?: {
    tokPerSec?: number
    promptTokPerSec?: number
    completionTokens?: number
    promptTokens?: number
    cacheN?: number
    ttftMs?: number
    /** Recorded per reply: a conversation can switch models mid-thread. */
    model?: string
  }
}

const DB_NAME = 'hearth'
const DB_VERSION = 5

let handle: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (handle) return handle
  handle = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId')
      }
      // v2. Guarded so an upgrade from v1 adds it without touching the rest.
      if (!db.objectStoreNames.contains('personas')) {
        db.createObjectStore('personas', { keyPath: 'id' })
      }
      // v3.
      if (!db.objectStoreNames.contains('prompts')) {
        db.createObjectStore('prompts', { keyPath: 'id' })
      }
      // v4. Small key-value store: directory handles, model notes.
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
      // v5. Durable facts, written by the extraction pass or by hand.
      if (!db.objectStoreNames.contains('memories')) {
        const store = db.createObjectStore('memories', { keyPath: 'id' })
        store.createIndex('scope', 'scope')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return handle
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function listConversations(): Promise<Conversation[]> {
  const all = await tx<Conversation[]>('conversations', 'readonly', (s) => s.getAll())
  return all.sort((a, b) => {
    const ap = a.pinnedAt ?? 0
    const bp = b.pinnedAt ?? 0
    if (ap && bp) return bp - ap
    if (ap) return -1
    if (bp) return 1
    return b.updatedAt - a.updatedAt
  })
}

export function putConversation(c: Conversation): Promise<IDBValidKey> {
  return tx('conversations', 'readwrite', (s) => s.put(c))
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['conversations', 'messages'], 'readwrite')
    t.objectStore('conversations').delete(id)
    const idx = t.objectStore('messages').index('conversationId')
    const cursorReq = idx.openKeyCursor(IDBKeyRange.only(id))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      t.objectStore('messages').delete(cursor.primaryKey)
      cursor.continue()
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction('messages', 'readonly')
    const req = t.objectStore('messages').index('conversationId').getAll(IDBKeyRange.only(conversationId))
    req.onsuccess = () => resolve((req.result as Message[]).sort((a, b) => a.createdAt - b.createdAt))
    req.onerror = () => reject(req.error)
  })
}

export function putMessage(m: Message): Promise<IDBValidKey> {
  return tx('messages', 'readwrite', (s) => s.put(m))
}

export async function deleteMessage(id: string): Promise<void> {
  await tx('messages', 'readwrite', (s) => s.delete(id))
}

export type SearchHit = {
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  createdAt: number
}

// Linear scan over every message. At a few thousand messages this is
// instant; if it ever isn't, that's the signal to add an FTS index.
export async function searchMessages(query: string, limit = 20): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const db = await open()
  const all = await new Promise<Message[]>((resolve, reject) => {
    const t = db.transaction('messages', 'readonly')
    const req = t.objectStore('messages').getAll()
    req.onsuccess = () => resolve(req.result as Message[])
    req.onerror = () => reject(req.error)
  })

  const hits: SearchHit[] = []
  for (const m of all) {
    const idx = m.content.toLowerCase().indexOf(q)
    if (idx === -1) continue
    const start = Math.max(0, idx - 40)
    const end = Math.min(m.content.length, idx + q.length + 60)
    hits.push({
      conversationId: m.conversationId,
      messageId: m.id,
      role: m.role,
      snippet: (start > 0 ? '…' : '') + m.content.slice(start, end).replace(/\s+/g, ' ').trim(),
      createdAt: m.createdAt,
    })
  }

  return hits.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export type Persona = {
  id: string
  name: string
  /** One line about who this is, shown in the picker. */
  note?: string
  /** Data URL, or absent for initials. */
  avatar?: string
  /** Prepended to every conversation's system prompt while active. */
  systemPrompt?: string
  createdAt: number
}

export type Prompt = {
  id: string
  name: string
  text: string
  createdAt: number
}

export type Backup = {
  format: 'hearth-backup'
  version: 4
  exportedAt: string
  conversations: Conversation[]
  messages: Message[]
  personas: Persona[]
  prompts: Prompt[]
  /** v4. Absent in older backups, which is why every read of it is `?? []`. */
  memories: Memory[]
}

export function makeBackup(
  conversations: Conversation[],
  messages: Message[],
  personas: Persona[] = [],
  prompts: Prompt[] = [],
  memories: Memory[] = [],
): Backup {
  return {
    format: 'hearth-backup',
    version: 4,
    exportedAt: new Date().toISOString(),
    conversations,
    messages,
    personas,
    prompts,
    memories,
  }
}

export async function exportAll(): Promise<Backup> {
  const db = await open()
  const read = <T,>(store: string) =>
    new Promise<T[]>((resolve, reject) => {
      const t = db.transaction(store, 'readonly')
      const req = t.objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result as T[])
      req.onerror = () => reject(req.error)
    })

  const [conversations, messages, personas, prompts, memories] = await Promise.all([
    read<Conversation>('conversations'),
    read<Message>('messages'),
    read<Persona>('personas'),
    read<Prompt>('prompts'),
    read<Memory>('memories'),
  ])

  return makeBackup(conversations, messages, personas, prompts, memories)
}

// Merge, never replace: restoring into an empty database brings everything
// back, and restoring into a populated one overwrites by id instead of
// destroying whatever else is there.
export async function importAll(
  backup: Backup,
  only?: string[],
): Promise<{
  conversations: number
  messages: number
  personas: number
  prompts: number
  memories: number
}> {
  const conversations = only ? backup.conversations.filter((c) => only.includes(c.id)) : backup.conversations
  const ids = new Set(conversations.map((c) => c.id))
  const messages = backup.messages.filter((m) => ids.has(m.conversationId))
  const personas = backup.personas ?? []
  const prompts = backup.prompts ?? []
  // Global and persona memories are not tied to a conversation, so a partial
  // restore keeps them. Conversation-scoped ones follow their conversation.
  const memories = (backup.memories ?? []).filter(
    (m) => m.scope !== 'conversation' || !m.ownerId || ids.has(m.ownerId),
  )

  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(
      ['conversations', 'messages', 'personas', 'prompts', 'memories'],
      'readwrite',
    )
    for (const c of conversations) t.objectStore('conversations').put(c)
    for (const m of messages) t.objectStore('messages').put(m)
    for (const p of personas) t.objectStore('personas').put(p)
    for (const p of prompts) t.objectStore('prompts').put(p)
    for (const m of memories) t.objectStore('memories').put(m)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })

  return {
    conversations: conversations.length,
    messages: messages.length,
    personas: personas.length,
    prompts: prompts.length,
    memories: memories.length,
  }
}

export type StatPoint = {
  model: string
  tokPerSec: number
  promptTokPerSec?: number
  ttftMs?: number
  completionTokens?: number
  promptTokens?: number
  cacheN?: number
  createdAt: number
}

// Only the numbers, not the text: the graph never needs message bodies.
export async function listStatPoints(): Promise<StatPoint[]> {
  const db = await open()
  const all = await new Promise<Message[]>((resolve, reject) => {
    const t = db.transaction('messages', 'readonly')
    const req = t.objectStore('messages').getAll()
    req.onsuccess = () => resolve(req.result as Message[])
    req.onerror = () => reject(req.error)
  })

  return all
    .filter((m) => m.stats?.tokPerSec)
    .map((m) => ({
      model: m.stats!.model ?? 'unknown',
      tokPerSec: m.stats!.tokPerSec!,
      promptTokPerSec: m.stats!.promptTokPerSec,
      ttftMs: m.stats!.ttftMs,
      completionTokens: m.stats!.completionTokens,
      promptTokens: m.stats!.promptTokens,
      cacheN: m.stats!.cacheN,
      createdAt: m.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function countMessages(): Promise<number> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction('messages', 'readonly')
    const req = t.objectStore('messages').count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listPersonas(): Promise<Persona[]> {
  const all = await tx<Persona[]>('personas', 'readonly', (s) => s.getAll())
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export function putPersona(p: Persona): Promise<IDBValidKey> {
  return tx('personas', 'readwrite', (s) => s.put(p))
}

export async function deletePersona(id: string): Promise<void> {
  await tx('personas', 'readwrite', (s) => s.delete(id))
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T } | undefined>('meta', 'readonly', (s) => s.get(key))
  return row?.value
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await tx('meta', 'readwrite', (s) => s.put({ key, value }))
}

export async function listPrompts(): Promise<Prompt[]> {
  const all = await tx<Prompt[]>('prompts', 'readonly', (s) => s.getAll())
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

export function putPrompt(p: Prompt): Promise<IDBValidKey> {
  return tx('prompts', 'readwrite', (s) => s.put(p))
}

export async function deletePrompt(id: string): Promise<void> {
  await tx('prompts', 'readwrite', (s) => s.delete(id))
}

// ---- memories ------------------------------------------------------------

export type MemoryScope = 'global' | 'conversation' | 'persona'

export type Memory = {
  id: string
  text: string
  scope: MemoryScope
  /** The conversation or persona this belongs to, when the scope needs one. */
  ownerId?: string
  createdAt: number
  updatedAt: number
  /** Where it came from, so the review panel can say. */
  sourceConversationId?: string
}

export async function listMemories(): Promise<Memory[]> {
  const all = await tx<Memory[]>('memories', 'readonly', (s) => s.getAll())
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export function putMemory(m: Memory): Promise<IDBValidKey> {
  return tx('memories', 'readwrite', (s) => s.put(m))
}

export function deleteMemory(id: string): Promise<undefined> {
  return tx('memories', 'readwrite', (s) => s.delete(id))
}

export function newId(): string {
  return crypto.randomUUID()
}

export function titleFrom(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? words.slice(0, 48) + '…' : words || 'Untitled'
}
