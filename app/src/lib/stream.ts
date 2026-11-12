// The whole project in miniature: POST, read the body as a stream,
// split SSE frames, accumulate deltas, stop when asked.
//
// Tool calls arrive the same way text does — as fragments — but they are keyed
// by index and their `arguments` is a JSON string built up piece by piece. The
// accumulator below is the only place that difference matters.

import { MANAGER } from './backend'

export type Stats = {
  tokPerSec?: number
  promptTokPerSec?: number
  completionTokens?: number
  promptTokens?: number
  /** Tokens served from the prompt cache — high means the prefix is reused. */
  cacheN?: number
  /** Milliseconds from request to first token. */
  ttftMs?: number
  /** 'stop' | 'length' | 'tool_calls' | ... — 'length' means the budget ran out. */
  finishReason?: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ToolCall = {
  id: string
  name: string
  /** The raw JSON the model emitted. Parsed by the caller, not here. */
  arguments: string
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** A plain string, or parts when the message carries images. */
  content: string | ContentPart[]
  reasoning?: string
  /** Present on an assistant turn that asked for tools. */
  tool_calls?: ToolCall[]
  /** Present on a tool result, pointing back at the call it answers. */
  tool_call_id?: string
}

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type StreamOptions = {
  baseUrl: string
  model: string
  messages: ChatMessage[]
  maxTokens: number
  /** 'default' or a reasoning_effort value. */
  effort?: string
  signal: AbortSignal
  tools?: ToolDef[]
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onStats?: (stats: Stats) => void
}

export type StreamResult = {
  /** Empty when the model answered with text instead of calling a tool. */
  toolCalls: ToolCall[]
}

/** Serialise a message for the wire, keeping the tool fields. */
function toWire(m: ChatMessage) {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }))
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  return out
}

export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const startedAt = performance.now()
  let firstTokenAt: number | null = null

  // Keyed by index: the server sends id and name once, then argument fragments.
  const pending = new Map<number, { id: string; name: string; args: string }>()

  function collect(): ToolCall[] {
    return [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.name)
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }))
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(toWire),
    stream: true,
    max_tokens: opts.maxTokens,
  }
  // Two conventions for the same idea, because there are two: OpenAI-style
  // `reasoning_effort`, and the chat-template flag llama.cpp exposes. Send both
  // and let the backend ignore the one it does not know.
  if (opts.effort && opts.effort !== 'default') {
    body.reasoning_effort = opts.effort
    if (opts.effort === 'none') body.chat_template_kwargs = { enable_thinking: false }
  }
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }

  // Through the manager, not straight at the backend: the browser cannot reach
  // an arbitrary local server (most send no CORS headers), and going through one
  // process means a backend is swapped by changing a string, not a code path.
  const res = await fetch(`${MANAGER}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hearth': '1' },
    signal: opts.signal,
    body: JSON.stringify({ ...body, baseUrl: opts.baseUrl }),
  })

  if (!res.ok) {
    // llama-server answers 503 with {"error":{"message":"Loading model"}} while it loads.
    const text = await res.text().catch(() => '')
    throw new Error(`backend ${res.status}: ${text.slice(0, 200) || res.statusText}`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    // A network chunk can end mid-frame. Keep the tail, parse only whole frames.
    buffer += decoder.decode(value, { stream: true })

    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return { toolCalls: collect() }

        let chunk: any
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue // partial or non-JSON keepalive
        }

        const delta = chunk.choices?.[0]?.delta

        // Reasoning models stream thinking in a separate field. Dropping it
        // makes the app look frozen until the answer starts.
        if (delta?.reasoning_content) {
          if (firstTokenAt === null) firstTokenAt = performance.now()
          opts.onReasoning?.(delta.reasoning_content)
        }
        if (delta?.content) {
          if (firstTokenAt === null) firstTokenAt = performance.now()
          opts.onDelta(delta.content)
        }

        if (Array.isArray(delta?.tool_calls)) {
          if (firstTokenAt === null) firstTokenAt = performance.now()
          for (const part of delta.tool_calls) {
            const index = typeof part.index === 'number' ? part.index : 0
            const slot = pending.get(index) ?? { id: '', name: '', args: '' }
            if (part.id) slot.id = part.id
            if (part.function?.name) slot.name = part.function.name
            if (part.function?.arguments) slot.args += part.function.arguments
            pending.set(index, slot)
          }
        }

        const finish = chunk.choices?.[0]?.finish_reason
        if (finish && opts.onStats) {
          opts.onStats({ finishReason: finish })
        }

        if (chunk.timings && opts.onStats) {
          opts.onStats({
            tokPerSec: chunk.timings.predicted_per_second,
            promptTokPerSec: chunk.timings.prompt_per_second,
            completionTokens: chunk.timings.predicted_n,
            promptTokens: chunk.timings.prompt_n,
            cacheN: chunk.timings.cache_n,
            ttftMs: firstTokenAt === null ? undefined : Math.round(firstTokenAt - startedAt),
          })
        }
      }
    }
  }

  return { toolCalls: collect() }
}
