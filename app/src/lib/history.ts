// The request, assembled: the system stack in a fixed order, then the turns
// that are still worth sending.
//
// This used to live inside `useHearth`, which meant the one thing that has cost
// real bugs — what goes into the prompt, in what order, and scoped to whom — was
// only testable by driving a React hook in a browser. It is pure assembly, so it
// belongs in a module with a test beside it.
//
// The order is the contract, and each move from it has a reason:
//
//   1. the date       — it frames everything after it (a roleplay in another era
//                       says so in its own prompt, which comes later and wins)
//   2. the profile    — who you are
//   3. the character  — who the model is
//   4. the summary    — what is no longer sent in full
//   5. memory         — facts recorded earlier, delimited as facts not orders
//   6. tool guidance  — what it may call, and what not to promise
//   7. this chat's    — the conversation's prompt, or the default, last
//
// The two rules that were bugs before they were code:
//
//   * **Resolve the character once.** The prompt used the resolved character and
//     the memory owner used the raw `conv.characterId`; `undefined ?? null` made
//     every character fact invisible while the prompt still applied, so the chat
//     looked right with its memory silently off.
//   * **An empty assistant turn is noise.** A turn that produced no text (the
//     budget went to thinking, or the user stopped it) makes the model reason
//     about "the empty response" instead of the question.

import type * as db from './db'
import type { ChatMessage } from './stream'
import { buildMemoryBlock } from './memory'
import { buildSummaryBlock, currentSummary, historyAfter } from './compaction'
import { toolGuidance, type ToolPolicy } from './tools'

/** Just what the assembly needs from the resolved character, so a test can pass a shape. */
export type AssembledCharacter = { id: string; systemPrompt?: string }

/** Just what the assembly needs from the resolved profile. */
export type AssembledProfile = { description?: string }

export type HistoryContext = {
  /**
   * Read fresh from the store, not from React state: a fact or a summary
   * written by a background pass after the last render must be in this request.
   */
  memories: db.Memory[]
  /** The character, already resolved — `conv.characterId` may mean "inherit". */
  character: AssembledCharacter | null
  profile: AssembledProfile | null
  /** `currentDateBlock()`: day granularity, because this is the cached prefix. */
  date: string
  policy: ToolPolicy
  /** Used when the conversation has no prompt of its own. */
  defaultPrompt: string
  /** Already trimmed by the caller; `buildHistory` fills it from the conversation. */
  conversationPrompt?: string | null
}

/**
 * Join the parts into the one system message, in the order above.
 *
 * Exported on its own because the order is the thing worth pinning: a test
 * asserts positions, not substrings.
 */
export function systemStack(parts: HistoryContext & { summaryBlock?: string; memoryBlock?: string }): string {
  const summaryBlock = parts.summaryBlock ?? ''
  const memoryBlock = parts.memoryBlock ?? ''
  return [
    parts.date,
    parts.profile?.description?.trim(),
    parts.character?.systemPrompt?.trim(),
    summaryBlock,
    memoryBlock,
    toolGuidance(parts.policy),
    // The conversation's own prompt is the fallback for the app-wide one; a
    // character's prompt is additive and does not replace either.
    parts.conversationPrompt?.trim() || parts.defaultPrompt,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The turns still sent in full. A summary replaces everything up to its
 * boundary, and a turn with no text and no attachments is dropped.
 */
export function sendableTurns(messages: db.Message[], summary: db.Memory | null): db.Message[] {
  return historyAfter(messages, summary).filter(
    (m) => m.content.trim().length > 0 || (m.attachments?.length ?? 0) > 0,
  )
}

/**
 * Assemble a request.
 *
 * `toChatMessage` stays a callback because a message with attachments needs an
 * async step (a file is inlined, an image becomes a data URL) and that is the
 * browser's business, not the assembler's.
 */
export async function buildHistory(
  messages: db.Message[],
  conv: db.Conversation,
  ctx: HistoryContext,
  toChatMessage: (m: db.Message) => Promise<ChatMessage>,
): Promise<ChatMessage[]> {
  const summary = currentSummary(ctx.memories, conv.id)
  // The *resolved* character's id, never the raw field: see the note above.
  const memoryBlock = buildMemoryBlock(ctx.memories, conv.id, ctx.character?.id ?? null)

  const system = systemStack({
    ...ctx,
    conversationPrompt: conv.systemPrompt ?? ctx.conversationPrompt,
    summaryBlock: buildSummaryBlock(summary),
    memoryBlock,
  })

  return [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...(await Promise.all(sendableTurns(messages, summary).map(toChatMessage))),
  ]
}
