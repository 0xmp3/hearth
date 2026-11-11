// The extension point.
//
// A "turn" is everything that happens between the user's message and the
// finished reply. Today that is one model call. An agent turn would be a loop
// that appends tool results and calls again — same signature, so the app
// never needs to know which one it is running.

import { streamChat, type ChatMessage, type Stats } from './stream'
import { BASE_URL } from './config'

export type TurnContext = {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  signal: AbortSignal
  append: (field: 'content' | 'reasoning', text: string) => void
  onStats: (stats: Stats) => void
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
