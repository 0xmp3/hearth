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
}

export type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: number
  aborted?: boolean
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
const DB_VERSION = 2

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
  /** Prepended to every conversation's system prompt while active. */
  systemPrompt?: string
  createdAt: number
}

export type Backup = {
  format: 'hearth-backup'
  version: 2
  exportedAt: string
  conversations: Conversation[]
  messages: Message[]
  personas: Persona[]
}

export function makeBackup(
  conversations: Conversation[],
  messages: Message[],
  personas: Persona[] = [],
): Backup {
  return {
    format: 'hearth-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    conversations,
    messages,
    personas,
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

  const [conversations, messages, personas] = await Promise.all([
    read<Conversation>('conversations'),
    read<Message>('messages'),
    read<Persona>('personas'),
  ])

  return makeBackup(conversations, messages, personas)
}

// Merge, never replace: restoring into an empty database brings everything
// back, and restoring into a populated one overwrites by id instead of
// destroying whatever else is there.
export async function importAll(
  backup: Backup,
  only?: string[],
): Promise<{ conversations: number; messages: number; personas: number }> {
  const conversations = only ? backup.conversations.filter((c) => only.includes(c.id)) : backup.conversations
  const ids = new Set(conversations.map((c) => c.id))
  const messages = backup.messages.filter((m) => ids.has(m.conversationId))
  const personas = backup.personas ?? []

  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['conversations', 'messages', 'personas'], 'readwrite')
    for (const c of conversations) t.objectStore('conversations').put(c)
    for (const m of messages) t.objectStore('messages').put(m)
    for (const p of personas) t.objectStore('personas').put(p)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })

  return { conversations: conversations.length, messages: messages.length, personas: personas.length }
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

export function newId(): string {
  return crypto.randomUUID()
}

export function titleFrom(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? words.slice(0, 48) + '…' : words || 'Untitled'
}
