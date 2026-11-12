// What the backend can serve, and what each model can do.
//
// Two engines, two shapes: llama.cpp's router reports a child's launch args
// (where `--ctx-size` lives) while a server like Strata reports the model's own
// metadata (`meta.n_ctx`, `architecture.input_modalities`). Both are read here,
// so the context bar and the vision check work either way.

import { MANAGER } from './backend'

export type ModelInfo = {
  id: string
  status?: string
  /** Context window in tokens, if the backend will say. */
  ctx?: number
  /** Whether the model accepts images. Undefined means "not stated here". */
  vision?: boolean
}

// The router reports each child's launch args, which is the only place the
// context window is visible — /props on the router itself returns n_ctx: 0.
function ctxFromArgs(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined
  const i = args.indexOf('--ctx-size')
  if (i === -1) return undefined
  const n = Number(args[i + 1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export async function listModels(baseUrl: string): Promise<ModelInfo[]> {
  // Through the manager: a local backend that sends no CORS headers (Strata) is
  // unreachable from the page, and this is the only call that needs the list.
  const res = await fetch(`${MANAGER}/api/models?baseUrl=${encodeURIComponent(baseUrl)}`, {
    headers: { 'X-Hearth': '1' },
  })
  if (!res.ok) throw new Error(`models ${res.status}`)
  const json = await res.json()
  return (json.data ?? []).map((m: any) => {
    const inputs: unknown = m.architecture?.input_modalities
    return {
      id: m.id,
      status: m.status?.value,
      ctx: ctxFromArgs(m.status?.args) ?? (Number(m.meta?.n_ctx) || undefined),
      vision: Array.isArray(inputs) ? inputs.includes('image') : undefined,
    }
  })
}
