// What the backend can serve. Router mode makes this a real list.

export type ModelInfo = { id: string; status?: string; ctx?: number }

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
  const res = await fetch(`${baseUrl}/v1/models`)
  if (!res.ok) throw new Error(`models ${res.status}`)
  const json = await res.json()
  return (json.data ?? []).map((m: any) => ({
    id: m.id,
    status: m.status?.value,
    ctx: ctxFromArgs(m.status?.args),
  }))
}
