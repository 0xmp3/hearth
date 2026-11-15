// The browser's own store, and the only thing still kept there.
//
// Vectors are a cache derived from messages: large, cheap to rebuild, and
// worthless without the text they came from. So they stay in IndexedDB, where a
// wipe costs a re-index rather than a conversation. Everything the user cannot
// get back lives in `data/hearth.db` and is read through the manager.
//
// The same database also holds the pre-SQLite library, which is why the store
// names below still exist: `readLegacy()` is the one-time migration, and it has
// to be able to see what the old version wrote.

export type VectorRow = {
  /** `${messageId}` or `${messageId}#${part}` for a long message. */
  id: string
  messageId: string
  conversationId: string
  part: number
  hash: string
  chars: number
  /** Which embedding model produced this vector, and at what width. */
  model: string
  dims: number
  /** L2-normalised on write, so a dot product is the cosine. */
  vector: Float32Array
  createdAt: number
}

/** What the index was built with. Lives beside the vectors so they die together. */
export type VectorMeta = {
  model: string
  dims: number
  prefix: string
  queryPrefix: string
  builtAt: number
}

const DB_NAME = 'hearth'
const DB_VERSION = 7

let handle: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (handle) return handle
  handle = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // The library stores are legacy: they are read once by the migration and
      // never written again. They are created here so a fresh browser has the
      // same shape as an upgraded one.
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId')
      }
      if (!db.objectStoreNames.contains('personas')) db.createObjectStore('personas', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('memories')) {
        const store = db.createObjectStore('memories', { keyPath: 'id' })
        store.createIndex('scope', 'scope')
      }
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('vectors')) {
        const store = db.createObjectStore('vectors', { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId')
        store.createIndex('messageId', 'messageId')
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

// ---- vectors ---------------------------------------------------------------

export async function putVectors(rows: VectorRow[]): Promise<void> {
  if (!rows.length) return
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('vectors', 'readwrite')
    for (const row of rows) t.objectStore('vectors').put(row)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export async function listVectors(conversationId?: string): Promise<VectorRow[]> {
  const db = await open()
  if (!conversationId) {
    return new Promise((resolve, reject) => {
      const t = db.transaction('vectors', 'readonly')
      const req = t.objectStore('vectors').getAll()
      req.onsuccess = () => resolve(req.result as VectorRow[])
      req.onerror = () => reject(req.error)
    })
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction('vectors', 'readonly')
    const req = t.objectStore('vectors').index('conversationId').getAll(IDBKeyRange.only(conversationId))
    req.onsuccess = () => resolve(req.result as VectorRow[])
    req.onerror = () => reject(req.error)
  })
}

export async function deleteVectorsForMessage(messageId: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('vectors', 'readwrite')
    const req = t.objectStore('vectors').index('messageId').openKeyCursor(IDBKeyRange.only(messageId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      t.objectStore('vectors').delete(cursor.primaryKey)
      cursor.continue()
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function deleteVectorsForConversation(conversationId: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('vectors', 'readwrite')
    const req = t.objectStore('vectors').index('conversationId').openKeyCursor(IDBKeyRange.only(conversationId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      t.objectStore('vectors').delete(cursor.primaryKey)
      cursor.continue()
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function countVectors(): Promise<number> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction('vectors', 'readonly')
    const req = t.objectStore('vectors').count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function clearVectors(): Promise<void> {
  await tx('vectors', 'readwrite', (s) => s.clear())
}

// ---- vector meta -----------------------------------------------------------

const VECTOR_META_KEY = 'vectors'

export async function getVectorMeta(): Promise<VectorMeta | undefined> {
  const row = await tx<{ key: string; value: VectorMeta } | undefined>('meta', 'readonly', (s) => s.get(VECTOR_META_KEY))
  return row?.value
}

export async function setVectorMeta(value: VectorMeta): Promise<void> {
  await tx('meta', 'readwrite', (s) => s.put({ key: VECTOR_META_KEY, value }))
}

// ---- the one-time migration ------------------------------------------------

export type LegacyLibrary = {
  conversations: unknown[]
  messages: unknown[]
  characters: unknown[]
  prompts: unknown[]
  memories: unknown[]
  profiles: unknown[]
}

/**
 * Everything the pre-SQLite version kept in the browser.
 *
 * Read once, on the first boot after the change, and never written again. The
 * data is left in place afterwards: it costs nothing, and if the migration ever
 * needs to be re-run the source is still there.
 */
export async function readLegacy(): Promise<LegacyLibrary> {
  const db = await open()
  const read = <T,>(store: string) =>
    new Promise<T[]>((resolve, reject) => {
      const t = db.transaction(store, 'readonly')
      const req = t.objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result as T[])
      req.onerror = () => reject(req.error)
    })

  const [conversations, messages, characters, prompts, memories, profiles] = await Promise.all([
    read<unknown>('conversations'),
    read<unknown>('messages'),
    read<unknown>('personas'),
    read<unknown>('prompts'),
    read<unknown>('memories'),
    read<unknown>('profiles'),
  ])

  return { conversations, messages, characters, prompts, memories, profiles }
}
