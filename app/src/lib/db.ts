// The library, through the manager.
//
// This file used to be IndexedDB. It is now a thin client over `data/hearth.db`,
// because the browser cannot be the only copy of something the user cannot get
// back: one "clear cookies and site data" and the whole library was gone.
//
// The function-per-operation shape is unchanged on purpose — every call site in
// the app still reads `db.listMessages(id)` — so the storage layer swapped
// underneath without the rest of the app noticing. What did change is that the
// manager is now required to read your history: it is the thing holding it.
//
// Vectors are the exception and live in `store.ts`: they are a cache, and a wipe
// should cost a re-index rather than a conversation.

import { MANAGER } from './backend'
import { clearVectors, countVectors, readLegacy } from './store'

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
  characterId?: string | null
  /**
   * Who you are in this conversation.
   * `undefined` = inherit the globally active profile, `null` = explicitly none.
   */
  profileId?: string | null
  /** Pre-rename field, still read for old records. */
  personaId?: string | null
  /**
   * What this conversation may use. Absent means "everything the app allows" —
   * which is the point: a conversation can narrow its tools, never widen them.
   */
  tools?: ToolMode
  /** Absent means the backend's own default. */
  effort?: EffortMode
  /** How this conversation dresses emphasis. Absent means `off`. */
  style?: TextStyle
  /**
   * Index this conversation for retrieval. Absent means no.
   *
   * Opt-in per conversation because indexing costs an embedding pass and a
   * little disk, and a chat you do not care about should not pay for either. The
   * vectors are a cache: deleting the index loses nothing.
   */
  index?: boolean
}

/**
 * A conversation's tool profile. The names are the modes people actually think
 * in, not the flags underneath: coding wants files, roleplay wants neither, and
 * agent work wants everything.
 */
export type ToolMode = 'default' | 'files' | 'web' | 'none'

/**
 * How hard the model is allowed to think before answering.
 *
 * `default` sends nothing, which is the only honest choice for a backend we know
 * nothing about. The rest are passed through as `reasoning_effort`; a backend
 * that does not know the value ignores it, and one that rejects it says so.
 */
export type EffortMode = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

import type { Attachment } from './attachments'

/**
 * One message a reply cited, so the UI can offer a chip that jumps to it.
 *
 * Stored on the message rather than recomputed: the reply is a record of what the
 * model was shown, and a later re-index must not change what an old answer cited.
 */
export type ToolSource = {
  conversationId: string
  messageId: string
  title: string
  role: 'user' | 'assistant'
  createdAt: number
  score: number
}

export type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: number
  aborted?: boolean
  /** The character that produced this reply, so history stays accurate. */
  characterId?: string | null
  /** The budget ran out before any answer was produced. */
  truncated?: boolean
  /** Files sent with this message. Text is inlined; images go as content parts. */
  attachments?: Attachment[]
  /** Tools this reply ran, so the activity is visible and not a black box. */
  tools?: { name: string; ok: boolean; summary: string; memoryId?: string; sources?: ToolSource[] }[]
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

// ---- transport -------------------------------------------------------------

/**
 * One call to the manager's store.
 *
 * A manager that is not running is not an empty library, and saying so is the
 * whole point of this error: the data is on disk, and the fix is to start the
 * thing that reads it.
 */
async function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${MANAGER}/api/db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hearth': '1' },
      body: JSON.stringify({ op, args }),
    })
  } catch {
    throw new Error(
      'the manager is not running, so the library cannot be read — it is on disk in data/hearth.db',
    )
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `store ${res.status}`)
  return (body as { result: T }).result
}

// ---- conversations ---------------------------------------------------------

export function listConversations(): Promise<Conversation[]> {
  return call<Conversation[]>('listConversations')
}

export function putConversation(c: Conversation): Promise<string> {
  return call<string>('putConversation', { conversation: c })
}

export function deleteConversation(id: string): Promise<void> {
  return call<void>('deleteConversation', { id })
}

/**
 * Delete every conversation, its messages, and the memories that belonged to it.
 *
 * What survives is the point: profiles, characters, prompts and global memories
 * are the user's setup, not their history. "Clear all chats" means "start the
 * conversation list again", not "factory reset" — a distinction worth keeping
 * because the destructive version is one word away and much harder to undo.
 */
export function clearConversations(): Promise<{ conversations: number; messages: number; memories: number }> {
  return call('clearConversations')
}

// ---- messages --------------------------------------------------------------

export function listMessages(conversationId: string): Promise<Message[]> {
  return call<Message[]>('listMessages', { conversationId })
}

export function putMessage(m: Message): Promise<string> {
  return call<string>('putMessage', { message: m })
}

export function getMessage(id: string): Promise<Message | undefined> {
  return call<Message | null>('getMessage', { id }).then((m) => m ?? undefined)
}

/** Batch read, so a search does not cost one round trip per hit. */
export function getMessages(ids: string[]): Promise<Message[]> {
  return call<Message[]>('getMessages', { ids })
}

export function deleteMessage(id: string): Promise<void> {
  return call<void>('deleteMessage', { id })
}

export type SearchHit = {
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  createdAt: number
}

export function searchMessages(query: string, limit = 20): Promise<SearchHit[]> {
  return call<SearchHit[]>('searchMessages', { query, limit })
}

export function countMessages(): Promise<number> {
  return call<number>('countMessages')
}

// ---- characters, prompts, profiles ----------------------------------------

export type Character = {
  id: string
  name: string
  /** One line about who this is, shown in the picker. */
  note?: string
  /** Data URL, or absent for initials. */
  avatar?: string
  /** Prepended to every conversation's system prompt while active. */
  systemPrompt?: string
  /**
   * Id of a reference clip in the manager's data/voices, or absent for "the
   * app-wide voice". Speech is the one place where a character's identity is
   * audible, so it belongs here rather than in settings alone.
   */
  voice?: string | null
  /**
   * 0–359, the character's colour — their version of MSN's coloured display
   * name. A hue rather than a hex, because the *saturation and lightness must
   * come from the theme*: the same hue has to be readable on a dark field and
   * on Parchment's white one, and only the theme knows which it is.
   */
  hue?: number
  createdAt: number
}

/**
 * How a reply's emphasis is dressed.
 *
 * `off` is plain bold. `colour` tints it with the character's hue. `expressive`
 * adds a slow drift on top. It is a *render-time* transform: nothing is stored
 * differently, the prompt is untouched, the text the model sees is unchanged,
 * and turning it off restores the plain reply instantly.
 */
export type TextStyle = 'off' | 'colour' | 'expressive'

export type Prompt = {
  id: string
  name: string
  text: string
  createdAt: number
}

export type Backup = {
  format: 'hearth-backup'
  version: 5
  exportedAt: string
  conversations: Conversation[]
  messages: Message[]
  characters: Character[]
  prompts: Prompt[]
  /** v4. Absent in older backups, which is why every read of it is `?? []`. */
  memories: Memory[]
  /** v5. Who the user is. Absent in v4 and earlier. */
  profiles: Profile[]
}

export function makeBackup(
  conversations: Conversation[],
  messages: Message[],
  characters: Character[] = [],
  prompts: Prompt[] = [],
  memories: Memory[] = [],
  profiles: Profile[] = [],
): Backup {
  return {
    format: 'hearth-backup',
    version: 5,
    exportedAt: new Date().toISOString(),
    conversations,
    messages,
    characters,
    prompts,
    memories,
    profiles,
  }
}

export function exportAll(): Promise<Backup> {
  return call<Backup>('exportAll')
}

// Merge, never replace: restoring into an empty database brings everything
// back, and restoring into a populated one overwrites by id instead of
// destroying whatever else is there.
export function importAll(
  backup: Backup,
  only?: string[],
): Promise<{
  conversations: number
  messages: number
  characters: number
  prompts: number
  memories: number
  profiles: number
}> {
  return call('importAll', { backup, only })
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
export function listStatPoints(): Promise<StatPoint[]> {
  return call<StatPoint[]>('listStatPoints')
}

export function listCharacters(): Promise<Character[]> {
  return call<Character[]>('listCharacters')
}

export function putCharacter(p: Character): Promise<string> {
  return call<string>('putCharacter', { character: p })
}

export function deleteCharacter(id: string): Promise<void> {
  return call<void>('deleteCharacter', { id })
}

export function getMeta<T>(key: string): Promise<T | undefined> {
  return call<T | null>('getMeta', { key }).then((v) => v ?? undefined)
}

export function setMeta<T>(key: string, value: T): Promise<void> {
  return call<void>('setMeta', { key, value })
}

export function listPrompts(): Promise<Prompt[]> {
  return call<Prompt[]>('listPrompts')
}

export function putPrompt(p: Prompt): Promise<string> {
  return call<string>('putPrompt', { prompt: p })
}

export function deletePrompt(id: string): Promise<void> {
  return call<void>('deletePrompt', { id })
}

// ---- profiles ------------------------------------------------------------

/**
 * Who the user is. A profile is how you introduce yourself in a conversation,
 * not a different person: memories stay global unless explicitly scoped.
 */
export type Profile = {
  id: string
  name: string
  /** A line or two about you, prepended while this profile is active. */
  description?: string
  avatar?: string
  createdAt: number
}

export function listProfiles(): Promise<Profile[]> {
  return call<Profile[]>('listProfiles')
}

export function putProfile(p: Profile): Promise<string> {
  return call<string>('putProfile', { profile: p })
}

export function deleteProfile(id: string): Promise<void> {
  return call<void>('deleteProfile', { id })
}

// ---- memories ------------------------------------------------------------

/**
 * Who a fact belongs to.
 *
 * There is no app-wide scope. A fact is either the character's — true in every
 * chat with them, which is what "remembering an old scenario" means — or this
 * conversation's. A character with no name is its own partition, so a blank
 * character starts blank and a roleplay never leaks into a coding chat.
 */
export type MemoryScope = 'conversation' | 'character'

export type Memory = {
  id: string
  text: string
  scope: MemoryScope
  /** The conversation or character this belongs to, when the scope needs one. */
  ownerId?: string
  /**
   * A condensed conversation rather than a fact. Summaries live in the same
   * store because they travel the same injection path, but they are not facts:
   * the extraction pass never sees them, and deleting one restores the full
   * transcript to the request.
   */
  kind?: 'fact' | 'summary'
  /** Summaries only: everything up to and including this message is covered. */
  throughMessageId?: string
  /** Summaries only: how many messages that is, in total. */
  messageCount?: number
  createdAt: number
  updatedAt: number
  /** Where it came from, so the review panel can say. */
  sourceConversationId?: string
  /**
   * Written by the model but not yet accepted by the user. Pending facts are
   * never injected into a prompt: the model proposes, the user decides.
   */
  pending?: boolean
}

export function listMemories(): Promise<Memory[]> {
  return call<Memory[]>('listMemories')
}

export function putMemory(m: Memory): Promise<string> {
  return call<string>('putMemory', { memory: m })
}

export function deleteMemory(id: string): Promise<void> {
  return call<void>('deleteMemory', { id })
}

// ---- indexes -------------------------------------------------------------

/**
 * Delete every vector and unset every conversation's index flag.
 *
 * The messages are untouched — this is the cache, not the transcript — which is
 * why it is the one bulk action that needs no backup: nothing is lost but the
 * time to rebuild. The vectors are in the browser and the flags are on disk, so
 * this is the one operation that spans both stores.
 */
export async function clearAllIndexes(): Promise<{ vectors: number; conversations: number }> {
  const vectors = await countVectors()
  const conversations = await listConversations()
  const indexed = conversations.filter((c) => c.index)
  await clearVectors()
  for (const conv of indexed) await putConversation({ ...conv, index: false })
  return { vectors, conversations: indexed.length }
}

// ---- migration ------------------------------------------------------------

export type MigrationResult = {
  migrated: boolean
  counts?: {
    conversations: number
    messages: number
    characters: number
    prompts: number
    memories: number
    profiles: number
  }
}

/**
 * Move the pre-SQLite library out of the browser, once.
 *
 * Gated on a flag in the *manager's* database rather than on "is it empty": a
 * user who deletes every conversation would otherwise have them all come back on
 * the next boot, which is the worst kind of resurrection bug.
 *
 * The browser copy is left in place. It costs nothing, and if this ever needs to
 * run again the source is still there.
 */
export async function migrateFromBrowser(): Promise<MigrationResult> {
  const done = await getMeta<{ at: number }>('migrated.indexeddb')
  if (done) return { migrated: false }

  const legacy = await readLegacy()
  const total =
    legacy.conversations.length +
    legacy.messages.length +
    legacy.characters.length +
    legacy.prompts.length +
    legacy.memories.length +
    legacy.profiles.length

  let counts: MigrationResult['counts']
  if (total > 0) {
    counts = await importAll({
      format: 'hearth-backup',
      version: 5,
      exportedAt: new Date().toISOString(),
      conversations: legacy.conversations as Conversation[],
      messages: legacy.messages as Message[],
      characters: legacy.characters as Character[],
      prompts: legacy.prompts as Prompt[],
      memories: legacy.memories as Memory[],
      profiles: legacy.profiles as Profile[],
    })
  }

  await setMeta('migrated.indexeddb', { at: Date.now(), counts: counts ?? null })
  return { migrated: total > 0, counts }
}

/** Where the library lives, and how much is in it. */
export function dbStats(): Promise<{
  path: string
  conversations: number
  messages: number
  characters: number
  prompts: number
  profiles: number
  memories: number
}> {
  return call('stats')
}

export function newId(): string {
  return crypto.randomUUID()
}

export function titleFrom(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? words.slice(0, 48) + '…' : words || 'Untitled'
}
