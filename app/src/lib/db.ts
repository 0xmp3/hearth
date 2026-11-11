// Persistence. No React, no network — just IndexedDB.
// Two stores: conversations, and messages indexed by conversationId.

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  systemPrompt?: string
}

export type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: number
  aborted?: boolean
  stats?: { tokPerSec?: number; completionTokens?: number }
}

const DB_NAME = 'hearth'
const DB_VERSION = 1

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
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
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

export function newId(): string {
  return crypto.randomUUID()
}

export function titleFrom(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? words.slice(0, 48) + '…' : words || 'Untitled'
}
