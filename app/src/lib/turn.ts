// The extension point.
//
// A "turn" is everything that happens between the user's message and the
// finished reply. `chatTurn` is one model call. `agentTurn` is a loop that runs
// tools and calls again — same signature, so the app never needs to know which
// one it is running.

import { streamChat, type ChatMessage, type Stats } from './stream'
import { toolsFor, type ToolRecord } from './tools'
import { BASE_URL } from './config'

/**
 * A confused model will call tools forever. Five rounds is enough for any
 * honest chain (remember → answer) and short enough that a loop is a hiccup
 * rather than a hang.
 */
export const MAX_TOOL_ROUNDS = 5

export type TurnContext = {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  signal: AbortSignal
  append: (field: 'content' | 'reasoning', text: string) => void
  onStats: (stats: Stats) => void
  /** Executes a tool call. Absent when tools are switched off. */
  runTool?: (name: string, args: unknown) => Promise<{ text: string; record: ToolRecord }>
  /** Egress switched on: adds the web tools to the request. */
  network?: boolean
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await streamChat({
      baseUrl: BASE_URL,
      model: ctx.model,
      messages,
      maxTokens: ctx.maxTokens,
      signal: ctx.signal,
      tools: ctx.runTool ? toolsFor(ctx.network === true) : undefined,
      onDelta: (text) => ctx.append('content', text),
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
