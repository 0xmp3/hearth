// The whole project in miniature: POST, read the body as a stream,
// split SSE frames, accumulate deltas, stop when asked.

import { MAX_TOKENS } from './config'

export type Stats = {
  tokPerSec?: number
  promptTokPerSec?: number
  completionTokens?: number
  promptTokens?: number
  /** Tokens served from the prompt cache — high means the prefix is reused. */
  cacheN?: number
  /** Milliseconds from request to first token. */
  ttftMs?: number
  /** 'stop' | 'length' | ... — 'length' means the budget ran out. */
  finishReason?: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  /** A plain string, or parts when the message carries images. */
  content: string | ContentPart[]
  reasoning?: string
}

export type StreamOptions = {
  baseUrl: string
  model: string
  messages: ChatMessage[]
  maxTokens: number
  signal: AbortSignal
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onStats?: (stats: Stats) => void
}

export async function streamChat(opts: StreamOptions): Promise<void> {
  const startedAt = performance.now()
  let firstTokenAt: number | null = null

  const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages.map(({ role, content }) => ({ role, content })),
      stream: true,
      max_tokens: opts.maxTokens,
    }),
  })

  if (!res.ok) {
    // llama-server answers 503 with {"error":{"message":"Loading model"}} while it loads.
    const body = await res.text().catch(() => '')
    throw new Error(`backend ${res.status}: ${body.slice(0, 200) || res.statusText}`)
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
        if (payload === '[DONE]') return

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
}
