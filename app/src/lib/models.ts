// What the backend can serve. Router mode makes this a real list.

export type ModelInfo = { id: string; status?: string }

export async function listModels(baseUrl: string): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl}/v1/models`)
  if (!res.ok) throw new Error(`models ${res.status}`)
  const json = await res.json()
  return (json.data ?? []).map((m: any) => ({ id: m.id, status: m.status?.value }))
}
