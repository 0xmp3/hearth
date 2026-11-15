// The library, on disk.
//
// Everything the user creates — conversations, messages, characters, profiles,
// prompts, memories — used to live in IndexedDB, which means "clear cookies and
// site data" destroyed all of it. Measured: one `Storage.clearDataForOrigin` and
// the whole library was gone. The browser cannot be the only copy of something
// the user cannot get back.
//
// So the source of truth is a SQLite file in `data/`, and the app reads it
// through the manager. `node:sqlite` is built into Node 24, so this costs no
// dependency and no native build — the same reason IndexedDB was chosen in the
// first place, minus the part where the data was disposable.
//
// Shape: one table per entity, the record as JSON in `data`, plus the columns we
// actually query on. That keeps the migration a straight copy and the queries
// indexed, and it means a field added to a record needs no schema change.
//
// Vectors are deliberately **not** here. They are a cache derived from messages,
// they are large, and rebuilding them is cheap — so they stay in the browser,
// where a wipe costs a re-index rather than a conversation.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  pinned_at INTEGER,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_by_scope ON memories (scope);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

let handle = null
let handlePath = null

export function dbPath(dataDir) {
  return join(dataDir, 'hearth.db')
}

function open(dataDir) {
  const path = dbPath(dataDir)
  if (handle && handlePath === path) return handle
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path)
  // WAL keeps a read from blocking a write, which matters because the app polls
  // while a reply streams and writes the draft as it goes.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  handle = db
  handlePath = path
  return db
}

export function close() {
  if (!handle) return
  try {
    handle.close()
  } catch {}
  handle = null
  handlePath = null
}

// ---- helpers ---------------------------------------------------------------

const parse = (row) => (row ? JSON.parse(row.data) : undefined)

function tx(db, fn) {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

// ---- conversations ---------------------------------------------------------

function listConversations(db) {
  // Pinned first, then most recently touched — the same order the sidebar has
  // always used, now expressed in SQL rather than a sort in the browser.
  const rows = db
    .prepare(
      `SELECT data FROM conversations
       ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC`,
    )
    .all()
  return rows.map(parse)
}

function putConversation(db, conv) {
  db.prepare(
    `INSERT INTO conversations (id, updated_at, pinned_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
       pinned_at = excluded.pinned_at, data = excluded.data`,
  ).run(conv.id, conv.updatedAt ?? Date.now(), conv.pinnedAt ?? null, JSON.stringify(conv))
  return conv.id
}

function deleteConversation(db, id) {
  tx(db, () => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    // A summary belongs to its thread; a fact about the user does not.
    db.prepare("DELETE FROM memories WHERE scope = 'conversation' AND owner_id = ?").run(id)
  })
}

function clearConversations(db) {
  return tx(db, () => {
    const conversations = count(db, 'conversations')
    const messages = count(db, 'messages')
    const memories = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = 'conversation'").get().n
    db.exec('DELETE FROM messages')
    db.exec('DELETE FROM conversations')
    db.prepare("DELETE FROM memories WHERE scope = 'conversation'").run()
    return { conversations, messages, memories }
  })
}

// ---- messages --------------------------------------------------------------

function listMessages(db, conversationId) {
  return db
    .prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId)
    .map(parse)
}

function putMessage(db, message) {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, created_at, content, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
       created_at = excluded.created_at, content = excluded.content, data = excluded.data`,
  ).run(
    message.id,
    message.conversationId,
    message.createdAt ?? Date.now(),
    message.content ?? '',
    JSON.stringify(message),
  )
  return message.id
}

function getMessage(db, id) {
  return parse(db.prepare('SELECT data FROM messages WHERE id = ?').get(id))
}

/** Batch read, so a search does not cost one round trip per hit. */
function getMessages(db, ids) {
  if (!ids?.length) return []
  const stmt = db.prepare('SELECT data FROM messages WHERE id = ?')
  return ids.map((id) => parse(stmt.get(id))).filter(Boolean)
}

function deleteMessage(db, id) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
}

function searchMessages(db, query, limit = 20) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  // LIKE with a leading wildcard cannot use an index, which is fine: this is the
  // palette's search over a personal library, and it was a full scan before too.
  const rows = db
    .prepare('SELECT data FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 200')
    .all(`%${q}%`)

  const hits = []
  for (const row of rows) {
    const m = JSON.parse(row.data)
    const idx = (m.content ?? '').toLowerCase().indexOf(q)
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
  return hits.slice(0, limit)
}

function countMessages(db) {
  return count(db, 'messages')
}

function listStatPoints(db) {
  // Only the numbers, not the text: the graph never needs message bodies.
  return db
    .prepare('SELECT data FROM messages ORDER BY created_at ASC')
    .all()
    .map(parse)
    .filter((m) => m?.stats?.tokPerSec)
    .map((m) => ({
      model: m.stats.model ?? 'unknown',
      tokPerSec: m.stats.tokPerSec,
      promptTokPerSec: m.stats.promptTokPerSec,
      ttftMs: m.stats.ttftMs,
      completionTokens: m.stats.completionTokens,
      promptTokens: m.stats.promptTokens,
      cacheN: m.stats.cacheN,
      createdAt: m.createdAt,
    }))
}

// ---- characters, prompts, profiles ----------------------------------------

function listCharacters(db) {
  return db.prepare('SELECT data FROM characters ORDER BY created_at ASC').all().map(parse)
}

function putCharacter(db, character) {
  db.prepare(
    `INSERT INTO characters (id, created_at, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`,
  ).run(character.id, character.createdAt ?? Date.now(), JSON.stringify(character))
  return character.id
}

function deleteCharacter(db, id) {
  db.prepare('DELETE FROM characters WHERE id = ?').run(id)
}

function listPrompts(db) {
  return db.prepare('SELECT data FROM prompts ORDER BY name ASC').all().map(parse)
}

function putPrompt(db, prompt) {
  db.prepare(
    `INSERT INTO prompts (id, name, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data`,
  ).run(prompt.id, prompt.name ?? '', JSON.stringify(prompt))
  return prompt.id
}

function deletePrompt(db, id) {
  db.prepare('DELETE FROM prompts WHERE id = ?').run(id)
}

function listProfiles(db) {
  return db.prepare('SELECT data FROM profiles ORDER BY created_at ASC').all().map(parse)
}

function putProfile(db, profile) {
  db.prepare(
    `INSERT INTO profiles (id, created_at, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`,
  ).run(profile.id, profile.createdAt ?? Date.now(), JSON.stringify(profile))
  return profile.id
}

function deleteProfile(db, id) {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
}

// ---- memories --------------------------------------------------------------

function listMemories(db) {
  return db.prepare('SELECT data FROM memories ORDER BY created_at ASC').all().map(parse)
}

function putMemory(db, memory) {
  db.prepare(
    `INSERT INTO memories (id, scope, owner_id, created_at, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, owner_id = excluded.owner_id,
       created_at = excluded.created_at, data = excluded.data`,
  ).run(
    memory.id,
    memory.scope ?? 'global',
    memory.ownerId ?? null,
    memory.createdAt ?? Date.now(),
    JSON.stringify(memory),
  )
  return memory.id
}

function deleteMemory(db, id) {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id)
}

// ---- meta ------------------------------------------------------------------

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? JSON.parse(row.value) : undefined
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value))
}

// ---- backup ----------------------------------------------------------------

function exportAll(db) {
  return {
    format: 'hearth-backup',
    version: 5,
    exportedAt: new Date().toISOString(),
    conversations: db.prepare('SELECT data FROM conversations').all().map(parse),
    messages: db.prepare('SELECT data FROM messages').all().map(parse),
    characters: db.prepare('SELECT data FROM characters').all().map(parse),
    prompts: db.prepare('SELECT data FROM prompts').all().map(parse),
    memories: db.prepare('SELECT data FROM memories').all().map(parse),
    profiles: db.prepare('SELECT data FROM profiles').all().map(parse),
  }
}

/**
 * Merge, never replace: restoring into an empty database brings everything back,
 * and restoring into a populated one overwrites by id instead of destroying
 * whatever else is there.
 */
function importAll(db, backup, only) {
  const conversations = only ? (backup.conversations ?? []).filter((c) => only.includes(c.id)) : (backup.conversations ?? [])
  const ids = new Set(conversations.map((c) => c.id))
  const messages = (backup.messages ?? []).filter((m) => ids.has(m.conversationId))
  const characters = backup.characters ?? []
  const prompts = backup.prompts ?? []
  // Global and character memories are not tied to a conversation, so a partial
  // restore keeps them. Conversation-scoped ones follow their conversation.
  const memories = (backup.memories ?? []).filter(
    (m) => m.scope !== 'conversation' || !m.ownerId || ids.has(m.ownerId),
  )
  const profiles = backup.profiles ?? []

  tx(db, () => {
    for (const c of conversations) putConversation(db, c)
    for (const m of messages) putMessage(db, m)
    for (const c of characters) putCharacter(db, c)
    for (const p of prompts) putPrompt(db, p)
    for (const m of memories) putMemory(db, m)
    for (const p of profiles) putProfile(db, p)
  })

  return {
    conversations: conversations.length,
    messages: messages.length,
    characters: characters.length,
    prompts: prompts.length,
    memories: memories.length,
    profiles: profiles.length,
  }
}

// ---- dispatch --------------------------------------------------------------

/**
 * One entry point, so the client keeps the function-per-operation shape it
 * already had and only the transport changes.
 */
export function run(dataDir, op, args = {}) {
  const db = open(dataDir)
  switch (op) {
    case 'listConversations':
      return listConversations(db)
    case 'putConversation':
      return putConversation(db, args.conversation)
    case 'deleteConversation':
      return deleteConversation(db, args.id)
    case 'clearConversations':
      return clearConversations(db)

    case 'listMessages':
      return listMessages(db, args.conversationId)
    case 'putMessage':
      return putMessage(db, args.message)
    case 'getMessage':
      return getMessage(db, args.id) ?? null
    case 'getMessages':
      return getMessages(db, args.ids)
    case 'deleteMessage':
      return deleteMessage(db, args.id)
    case 'searchMessages':
      return searchMessages(db, args.query, args.limit)
    case 'countMessages':
      return countMessages(db)
    case 'listStatPoints':
      return listStatPoints(db)

    case 'listCharacters':
      return listCharacters(db)
    case 'putCharacter':
      return putCharacter(db, args.character)
    case 'deleteCharacter':
      return deleteCharacter(db, args.id)

    case 'listPrompts':
      return listPrompts(db)
    case 'putPrompt':
      return putPrompt(db, args.prompt)
    case 'deletePrompt':
      return deletePrompt(db, args.id)

    case 'listProfiles':
      return listProfiles(db)
    case 'putProfile':
      return putProfile(db, args.profile)
    case 'deleteProfile':
      return deleteProfile(db, args.id)

    case 'listMemories':
      return listMemories(db)
    case 'putMemory':
      return putMemory(db, args.memory)
    case 'deleteMemory':
      return deleteMemory(db, args.id)

    case 'getMeta':
      return getMeta(db, args.key) ?? null
    case 'setMeta':
      return setMeta(db, args.key, args.value)

    case 'exportAll':
      return exportAll(db)
    case 'importAll':
      return importAll(db, args.backup, args.only)

    case 'stats':
      return {
        path: dbPath(dataDir),
        conversations: count(db, 'conversations'),
        messages: count(db, 'messages'),
        characters: count(db, 'characters'),
        prompts: count(db, 'prompts'),
        profiles: count(db, 'profiles'),
        memories: count(db, 'memories'),
      }

    default:
      throw new Error(`unknown db op: ${op}`)
  }
}
