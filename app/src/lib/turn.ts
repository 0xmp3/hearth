// The extension point.
//
// A "turn" is everything that happens between the user's message and the
// finished reply. `chatTurn` is one model call. `agentTurn` is a loop that runs
// tools and calls again — same signature, so the app never needs to know which
// one it is running.

import { streamChat, type ChatMessage, type Stats } from './stream'
import { NO_TOOLS, toolsFor, type ToolPolicy, type ToolRecord } from './tools'

/** An empty list is not a list: `tools: []` is rejected by some servers, and
 *  "no tools" is properly expressed by leaving the field out. */
function toolList(policy: ToolPolicy | undefined) {
  const list = toolsFor(policy ?? NO_TOOLS)
  return list.length ? list : undefined
}
import { BASE_URL } from './config'

/**
 * A confused model will call tools forever. Eight rounds fits the longest honest
 * chain with search in it (search → read → read → answer) with room for a
 * correction, and is short enough that a loop is a hiccup rather than a hang.
 * Five was chosen before search existed, and a real question — "what is the
 * current stable version of X" — used all five and got cut off mid-answer.
 */
export const MAX_TOOL_ROUNDS = 8

export type TurnContext = {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  signal: AbortSignal
  append: (field: 'content' | 'reasoning', text: string) => void
  onStats: (stats: Stats) => void
  /** Executes a tool call. Absent when tools are switched off. */
  runTool?: (name: string, args: unknown) => Promise<{ text: string; record: ToolRecord }>
  /** Which tool families this turn may use. Absent means none. */
  tools?: ToolPolicy
  /** Reports a tool that ran, for the message body. */
  onTool?: (record: ToolRecord) => void
}

export type TurnDriver = (ctx: TurnContext) => Promise<void>

export const chatTurn: TurnDriver = async (ctx) => {
  await streamChat({
    baseUrl: BASE_URL,
    model: ctx.model,
    messages: ctx.messages,
    maxTokens: ctx.maxTokens,
    signal: ctx.signal,
    onDelta: (text) => ctx.append('content', text),
    onReasoning: (text) => ctx.append('reasoning', text),
    onStats: ctx.onStats,
  })
}

export const agentTurn: TurnDriver = async (ctx) => {
  // The history grows as tools run, so it is copied rather than mutated.
  const messages: ChatMessage[] = [...ctx.messages]

  // Text from different rounds is different paragraphs. The model narrates
  // before a tool call ("let me look at the folder") and continues after the
  // result ("yes, it holds one file"), and those two runs were being glued
  // together into "...read the file.Yes — the workspace holds...". A blank line
  // between rounds is the whole fix; `fresh` resets per round so the separator
  // is only added when a round actually says something.
  let wrote = false
  let fresh = false
  let tail = ''
  const say = (text: string) => {
    // Only when the previous round did not already end on a line break: the
    // model often closes its narration with one, and doubling it leaves a gap.
    if (!fresh && wrote && !tail.endsWith('\n')) ctx.append('content', '\n\n')
    fresh = true
    wrote = true
    tail = (tail + text).slice(-2)
    ctx.append('content', text)
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    fresh = false
    const result = await streamChat({
      baseUrl: BASE_URL,
      model: ctx.model,
      messages,
      maxTokens: ctx.maxTokens,
      signal: ctx.signal,
      tools: ctx.runTool ? toolList(ctx.tools) : undefined,
      onDelta: say,
      onReasoning: (text) => ctx.append('reasoning', text),
      onStats: ctx.onStats,
    })

    // No calls means the model answered. Done.
    if (!result.toolCalls.length) return

    // The assistant turn that asked, then one result per call. Both are needed:
    // the model cannot match a result to a call without the pair.
    messages.push({ role: 'assistant', content: '', tool_calls: result.toolCalls })

    for (const call of result.toolCalls) {
      let args: unknown = {}
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        args = {}
      }

      const outcome = ctx.runTool
        ? await ctx.runTool(call.name, args)
        : { text: 'Tools are unavailable.', record: { name: call.name, ok: false, summary: 'unavailable' } }

      ctx.onTool?.(outcome.record)
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
    }
  }

  // Out of rounds. Say so rather than ending on silence.
  ctx.append('content', '\n\n(stopped after too many tool calls)')
}
