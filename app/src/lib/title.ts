import type { ChatMessage } from './stream'

// Auxiliary calls like this one must not think. On a reasoning model, a 32-token
// budget gets spent entirely on reasoning and returns empty content — measured:
// 115 reasoning tokens, 0 content. `enable_thinking: false` answers in ~0.2s.
const NO_THINK = { enable_thinking: false }

type TitleRequest = {
  baseUrl: string
  model: string
  messages: unknown[]
  maxTokens: number
  signal?: AbortSignal
}

async function request(req: TitleRequest, think: boolean): Promise<string | null> {
  const res = await fetch(`${req.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
      max_tokens: req.maxTokens,
      temperature: 0.2,
      ...(think ? {} : { chat_template_kwargs: NO_THINK }),
    }),
  })
  if (!res.ok) return null
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? null
}

function clean(raw: string | null): string | null {
  if (!raw) return null
  const title = raw
    .trim()
    .replace(/^["'“”'`]+|["'“”'`]+$/g, '')
    .replace(/^(title|conversation)\s*[:\-]\s*/i, '')
    .split('\n')[0]
    .trim()
    .replace(/[.;:]$/, '')
  if (!title || title.length > 64) return null
  return title
}

export async function suggestTitle(
  baseUrl: string,
  model: string,
  firstUser: string,
  firstReply: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const prompt = [
    'Give this conversation a title of at most 6 words.',
    'Reply with the title only — no quotes, no full stop, no preamble.',
    '',
    `User: ${firstUser.slice(0, 600)}`,
    `Assistant: ${firstReply.slice(0, 600)}`,
  ].join('\n')

  const base: TitleRequest = {
    baseUrl,
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 64,
    signal,
  }

  // Fast path: thinking off. Slow path: templates that ignore the flag need
  // enough budget to finish thinking before they answer.
  const quick = clean(await request(base, false))
  if (quick) return quick

  return clean(await request({ ...base, maxTokens: 900 }, true))
}
