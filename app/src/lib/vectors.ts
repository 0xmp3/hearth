// Retrieval over your own history.
//
// The message is the truth; a vector is a cache derived from it. That single
// sentence decides most of this file: rows are keyed to the message they came
// from, they are deleted when it is, they are skipped when it has not changed,
// and they can all be thrown away and rebuilt without losing a word.
//
// Three things here are not obvious and cost real bugs if changed:
//
//   * **Chunk by message.** A PDF needs a chunking window because it has no
//     semantic boundaries; a chat message is already one. Only a message that
//     runs long is split, and then on paragraph breaks.
//   * **The embedding model is part of the vector.** Same 768 numbers, different
//     space, and no error to tell you — so the model is stored with the index and
//     a mismatch is refused rather than scored.
//   * **Vectors are L2-normalised on write**, so a search is a dot product. The
//     server already returns unit vectors; normalising again is insurance that
//     costs 768 multiplications per row.
//
// What this file does *not* do: decide a similarity floor. EmbeddingGemma scores
// unrelated text at ~0.43, so any threshold chosen by eye returns either
// everything or nothing. That number comes from the test corpus in docs/rag.md.

import * as db from './db'
import { manager } from './backend'

/** One meta record, so a half-built index cannot claim to be the whole one. */
export const VECTOR_META_KEY = 'vectors'

export type VectorMeta = {
  /** The model *path*, because that is what the manager resolves and loads. */
  model: string
  dims: number
  /** The task prefixes the manager applied. A change invalidates every vector. */
  prefix: string
  queryPrefix: string
  builtAt: number
}

/** A message part is embedded whole below this; above it, split on paragraphs. */
const MAX_CHUNK = 1200

/** The engine answers this many inputs per call at most. */
const BATCH = 32

/**
 * Split a message into the pieces that get embedded.
 *
 * Empty messages produce nothing: an assistant turn that only ran tools has no
 * text worth a vector, and embedding whitespace pollutes every search.
 */
export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const src = String(text ?? '')
  if (!src.trim()) return []

  const blocks = src
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  const out: string[] = []
  let buf = ''
  const flush = () => {
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }

  for (const block of blocks) {
    if (block.length > max) {
      flush()
      let rest = block
      while (rest.length > max) {
        const window = rest.slice(0, max)
        // Break on a sentence, a line, or a space — in that order. A hard cut
        // mid-word is the last resort, not the first.
        const sentence = window.lastIndexOf('. ')
        const line = window.lastIndexOf('\n')
        const space = window.lastIndexOf(' ')
        const cut = Math.max(sentence + 1, line, space)
        const at = cut > max * 0.5 ? cut : max
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).replace(/^\s+/, '')
      }
      if (rest.trim()) buf = rest.trim()
      continue
    }
    if ((buf ? buf.length + 2 : 0) + block.length > max) flush()
    buf = buf ? `${buf}\n\n${block}` : block
  }
  flush()
  return out
}

/**
 * A cheap content hash. FNV-1a plus the length, which is enough to tell an edit
 * from a re-render: the only question it answers is "is this the same text I
 * embedded last time", and a collision would have to be the same length too.
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}:${text.length}`
}

function normalise(vector: number[]): Float32Array {
  const out = new Float32Array(vector.length)
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (!norm) return out
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  return out
}

/** Cosine, because both sides are unit vectors. */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i]
  return sum
}

export type IndexOutcome = {
  conversationId: string
  model: string
  dims: number
  /** Messages considered. */
  messages: number
  /** Chunks the index now holds for this conversation. */
  chunks: number
  /** Messages whose text was already indexed and unchanged. */
  skipped: number
  /** Chunks embedded in this pass. */
  written: number
}

/**
 * Embed one conversation.
 *
 * Idempotent and incremental: a message whose chunks all hash the same as what
 * is stored is skipped, so calling this after every reply costs one embedding
 * call per new message rather than a re-index.
 */
export async function indexConversation(
  conversationId: string,
  opts: { force?: boolean } = {},
): Promise<IndexOutcome> {
  const state = await manager.embedState()
  if (!state.enabled) throw new Error('indexing is off — turn it on in Settings')
  if (!state.ready) throw new Error('no embedding model is set')

  const meta = await db.getMeta<VectorMeta>(VECTOR_META_KEY)
  const changedModel = Boolean(meta && meta.model !== state.model.path)
  const changedPrefix = Boolean(
    meta && (meta.prefix !== state.prefix || meta.queryPrefix !== state.queryPrefix),
  )

  if ((changedModel || changedPrefix) && !opts.force) {
    throw new Error(
      changedModel
        ? 'the index was built with a different embedding model — rebuild it'
        : 'the embedding prefix changed — rebuild the index',
    )
  }
  // A forced rebuild starts clean: comparing vectors from two models is not a
  // weaker answer, it is a meaningless one.
  if (changedModel) await db.clearVectors()

  const messages = await db.listMessages(conversationId)
  const existing = new Map<string, Map<number, string>>()
  for (const row of await db.listVectors(conversationId)) {
    const parts = existing.get(row.messageId) ?? new Map<number, string>()
    parts.set(row.part, row.hash)
    existing.set(row.messageId, parts)
  }

  const plan: { message: db.Message; part: number; text: string; hash: string }[] = []
  let skipped = 0

  for (const message of messages) {
    const parts = chunkText(message.content)
    if (!parts.length) continue
    const have = existing.get(message.id)
    const unchanged =
      have &&
      have.size === parts.length &&
      parts.every((text, part) => have.get(part) === hashText(text))
    if (unchanged) {
      skipped += 1
      continue
    }
    parts.forEach((text, part) => plan.push({ message, part, text, hash: hashText(text) }))
  }

  // Anything being written is written whole: a message that shrank would
  // otherwise leave its old tail retrievable, pointing at text that is gone.
  const rewritten = new Set(plan.map((item) => item.message.id))
  for (const id of rewritten) await db.deleteVectorsForMessage(id)

  let dims = meta?.dims ?? 0
  let written = 0

  for (let i = 0; i < plan.length; i += BATCH) {
    const batch = plan.slice(i, i + BATCH)
    const result = await manager.embed(batch.map((item) => item.text))
    dims = result.dims
    const now = Date.now()
    const rows: db.VectorRow[] = batch.map((item, n) => ({
      id: item.part ? `${item.message.id}#${item.part}` : item.message.id,
      messageId: item.message.id,
      conversationId,
      part: item.part,
      hash: item.hash,
      chars: item.text.length,
      model: result.model,
      dims: result.dims,
      vector: normalise(result.vectors[n]),
      createdAt: now,
    }))
    await db.putVectors(rows)
    written += rows.length
  }

  if (written || !meta) {
    await db.setMeta<VectorMeta>(VECTOR_META_KEY, {
      model: state.model.path,
      dims,
      prefix: state.prefix,
      queryPrefix: state.queryPrefix,
      builtAt: Date.now(),
    })
  }

  return {
    conversationId,
    model: state.model.path,
    dims,
    messages: messages.length,
    chunks: plan.length + skipped,
    skipped,
    written,
  }
}

export type VectorHit = {
  messageId: string
  conversationId: string
  part: number
  /**
   * The ordering score: the reranker's logit when it ran, otherwise the cosine.
   * Comparable within one result set and meaningless across calls.
   */
  score: number
  /** The cosine, always. This is the number the floor is calibrated against. */
  similarity: number
  text: string
  role: 'user' | 'assistant'
  createdAt: number
}

export type SearchOutcome = {
  hits: VectorHit[]
  model: string
  dims: number
  /** Vectors compared. */
  scanned: number
  /**
   * The best cosine seen, floor or not. This is the number a floor gets
   * calibrated against — a search that found nothing still has a top score, and
   * knowing it is 0.31 rather than 0.62 is how you tell "no match" from "the
   * floor is wrong".
   */
  top: number
  /** Whether a cross-encoder reordered the candidates. */
  reranked: boolean
  rerankModel: string | null
}

/**
 * Find messages that mean roughly what `query` means.
 *
 * Two stages, and the second is what makes it usable. The embedding stage is a
 * bi-encoder: it compares two summaries of meaning, and on short chat messages it
 * put the right answer anywhere from 1st to 36th. The reranker is a cross-encoder
 * that reads query and message together; over the top 10 candidates it moved the
 * answer to the top 3 in every case measured, and to 1st in half of them.
 *
 * `floor` applies to the **cosine**, not the reranker's logit, because the cosine
 * is the number that can be calibrated across models and the logit cannot. The
 * reranker reorders; it does not decide what counts as a match.
 */
export async function searchVectors(
  query: string,
  opts: { limit?: number; floor?: number; conversationId?: string; candidates?: number } = {},
): Promise<SearchOutcome> {
  const text = String(query ?? '').trim()
  if (!text) throw new Error('nothing to search for')

  const state = await manager.embedState()
  if (!state.enabled) throw new Error('indexing is off — turn it on in Settings')

  const meta = await db.getMeta<VectorMeta>(VECTOR_META_KEY)
  if (!meta) throw new Error('nothing is indexed yet')
  if (meta.model !== state.model.path) {
    throw new Error('the index was built with a different embedding model — rebuild it')
  }

  const embedded = await manager.embed([text], 'query')
  const queryVector = normalise(embedded.vectors[0])

  const rows = await db.listVectors(opts.conversationId)
  const scored: { row: db.VectorRow; similarity: number }[] = []
  let top = 0

  for (const row of rows) {
    // A row from another model would compare garbage at the same width. The
    // meta check above catches the configured case; this catches a half-cleared
    // store.
    if (row.dims !== queryVector.length) continue
    const similarity = dot(queryVector, row.vector)
    if (similarity > top) top = similarity
    if (similarity < (opts.floor ?? 0)) continue
    scored.push({ row, similarity })
  }

  scored.sort((a, b) => b.similarity - a.similarity)

  // How many candidates the reranker sees. More than the caller asked for,
  // because the reranker's job is to find the one the embedding stage buried.
  const rerankState = await manager.rerankState().catch(() => null)
  const rerankReady = Boolean(rerankState?.enabled && rerankState.ready)
  const candidates = Math.max(
    opts.limit ?? 5,
    Math.min(opts.candidates ?? rerankState?.candidates ?? 10, scored.length),
  )
  const shortlist = scored.slice(0, candidates)

  // The text is fetched here rather than stored with the vector: the message is
  // the truth, and a vector row that outlived an edit would otherwise return
  // text that is no longer in the transcript.
  const hits: VectorHit[] = []
  for (const { row, similarity } of shortlist) {
    const message = await db.getMessage(row.messageId)
    if (!message) continue
    hits.push({
      messageId: row.messageId,
      conversationId: row.conversationId,
      part: row.part,
      score: similarity,
      similarity,
      text: message.content,
      role: message.role,
      createdAt: message.createdAt,
    })
  }

  let reranked = false
  let rerankModel: string | null = null

  if (rerankReady && hits.length > 1) {
    try {
      const result = await manager.rerank(text, hits.map((hit) => hit.text))
      const order = result.results
        .filter((r) => r.index >= 0 && r.index < hits.length)
        .map((r) => ({ hit: hits[r.index], score: r.score }))
      // A reranker that returns fewer rows than it was given must not silently
      // drop the rest: append whatever it did not mention, in cosine order.
      const seen = new Set(result.results.map((r) => r.index))
      hits.forEach((hit, i) => {
        if (!seen.has(i)) order.push({ hit, score: hit.similarity })
      })
      hits.length = 0
      for (const { hit, score } of order) hits.push({ ...hit, score })
      reranked = true
      rerankModel = result.model
    } catch {
      // A reranker that is down must not break a search: the cosine order is
      // still a result, just a worse one.
      reranked = false
    }
  }

  return {
    hits: hits.slice(0, opts.limit ?? 5),
    model: meta.model,
    dims: meta.dims,
    scanned: rows.length,
    top,
    reranked,
    rerankModel,
  }
}

export type VectorStats = {
  count: number
  conversations: number
  model: string | null
  dims: number
  /** Roughly what the index costs on disk: 4 bytes per dimension, plus keys. */
  bytes: number
}

export async function vectorStats(): Promise<VectorStats> {
  const rows = await db.listVectors()
  const meta = await db.getMeta<VectorMeta>(VECTOR_META_KEY)
  const conversations = new Set(rows.map((row) => row.conversationId))
  return {
    count: rows.length,
    conversations: conversations.size,
    model: meta?.model ?? null,
    dims: meta?.dims ?? rows[0]?.dims ?? 0,
    bytes: rows.reduce((sum, row) => sum + row.vector.length * 4 + row.id.length + 64, 0),
  }
}

/** Turn a conversation's toggle off: the vectors go, the messages stay. */
export async function dropConversationIndex(conversationId: string): Promise<void> {
  await db.deleteVectorsForConversation(conversationId)
}
