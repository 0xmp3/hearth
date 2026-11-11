// The model server's own view of itself.
//
// Two endpoints, and they are not equally useful:
//
//   /slots    live. `next_token[0].n_decoded` counts tokens as they are
//             produced, so throughput can be derived from its delta.
//   /metrics  cumulative. `tokens_predicted_total` only moves when a request
//             *finishes*, so it is useless for a live rate — it produces one
//             spike at the end. It is still the right source for totals and
//             prompt-cache hits.
//
// `llamacpp:predicted_tokens_seconds` is exported but always reads 0 in this
// build, so it is ignored rather than trusted.
//
// Router mode requires a model name on every request, so the caller passes the
// one the app currently has selected.

const CACHE_MS = 500
let cache = { at: 0, model: null, data: null }

// Live counters need a previous reading to diff against.
let last = { decoded: null, at: 0 }

function parseMetrics(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const space = line.lastIndexOf(' ')
    if (space === -1) continue
    const value = Number(line.slice(space + 1))
    if (Number.isFinite(value)) out[line.slice(0, space).trim()] = value
  }
  return out
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function serverView(port, model) {
  if (!model) return null
  if (cache.model === model && Date.now() - cache.at < CACHE_MS) return cache.data

  const base = `http://127.0.0.1:${port}`
  const q = `?model=${encodeURIComponent(model)}`

  let metrics = null
  let slots = null

  try {
    const res = await fetch(`${base}/metrics${q}`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) metrics = parseMetrics(await res.text())
  } catch {
    // --metrics not enabled, or the server is not up. Both are normal.
  }

  try {
    slots = await getJson(`${base}/slots${q}`)
  } catch {
    slots = null
  }

  const list = Array.isArray(slots) ? slots : []
  const busy = list.filter((s) => s.is_processing)
  const decoded = list.reduce((n, s) => n + (s.next_token?.[0]?.n_decoded ?? 0), 0)

  const now = Date.now()
  const seconds = last.at ? (now - last.at) / 1000 : 0
  let tokensPerSecond = null
  if (last.decoded != null && seconds > 0) {
    const delta = decoded - last.decoded
    // A negative delta means the request finished and the slot reset.
    if (delta >= 0) tokensPerSecond = Math.round((delta / seconds) * 10) / 10
  }
  last = { decoded, at: now }

  const active = busy[0]
  const contextTokens = active
    ? (active.n_prompt_tokens ?? 0) + (active.next_token?.[0]?.n_decoded ?? 0)
    : null

  const data = {
    tokensPerSecond,
    contextTokens,
    tokensPredicted: metrics?.['llamacpp:tokens_predicted_total'] ?? null,
    promptTokens: metrics?.['llamacpp:prompt_tokens_total'] ?? null,
    promptTokensCached: metrics?.['llamacpp:prompt_tokens_cached_total'] ?? null,
    requestsProcessing: metrics?.['llamacpp:requests_processing'] ?? busy.length,
    requestsDeferred: metrics?.['llamacpp:requests_deferred'] ?? null,
    slots: list.length
      ? { total: list.length, busy: busy.length, nCtx: list[0]?.n_ctx ?? null }
      : null,
    metricsEnabled: metrics !== null,
  }

  cache = { at: Date.now(), model, data }
  return data
}
