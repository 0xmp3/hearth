// Web search, behind the same switch and the same manager as web_read.
//
// Two providers, because the choice is about the user's machine, not about the
// protocol:
//
//   brave    — a key, a JSON API, results that arrive in the shape a tool wants.
//              The pragmatic default: it works with no local service running.
//   searxng  — a metasearch instance the user runs themselves. No key, no
//              account, but it is a service to keep alive and its JSON format
//              has to be enabled in its own settings.yml.
//
// A third option — scraping DuckDuckGo — was tested and is not here on purpose:
// all three of its HTML endpoints answer 202 to a machine that is not a browser,
// so the feature would be broken on arrival. A search tool that sometimes lies
// about having searched is worse than one that says it is not configured.

const BRAVE_SEARCH = 'https://api.search.brave.com/res/v1/web/search'
// Only for a stub in tests: the real endpoint is fixed.
const BRAVE_BASE = process.env.HEARTH_SEARCH_BASE ?? BRAVE_SEARCH

const UA = 'Hearth/0.1 (local app)'
const TIMEOUT_MS = 12000
const MAX_RESULTS = 10

export class NotConfigured extends Error {}

function trimSnippet(text, limit = 320) {
  const clean = String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

async function braveSearch(query, count, key) {
  const url = new URL(BRAVE_BASE)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  url.searchParams.set('safesearch', 'moderate')

  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key, 'User-Agent': UA },
  })
  if (res.status === 401 || res.status === 403) throw new Error('the Brave key was refused — check it in Settings')
  if (res.status === 429) throw new Error('Brave rate limit reached (the free tier allows a few queries a second)')
  if (!res.ok) throw new Error(`search answered ${res.status}`)

  const body = await res.json()
  const results = Array.isArray(body?.web?.results) ? body.web.results : []
  return results.map((r) => ({
    title: trimSnippet(r.title, 160) || hostOf(r.url) || r.url,
    url: r.url,
    snippet: trimSnippet(r.description),
  }))
}

/**
 * The SearXNG endpoint is meant to be local, so it does *not* go through the
 * public-address check that readUrl uses — that would refuse the very thing the
 * feature is for. It is still a URL the user typed into settings, not one a
 * model invented, so the checks are about shape rather than exoticness.
 */
function searxEndpoint(raw) {
  const url = checkShape(raw)
  const base = url.toString().replace(/\/+$/, '')
  return `${base}/search`
}

function checkShape(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error('the SearXNG address is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('the SearXNG address must be http or https')
  if (url.username || url.password) throw new Error('put credentials in the SearXNG settings, not in the address')
  return url
}

async function searxSearch(query, count, endpoint) {
  const url = new URL(searxEndpoint(endpoint))
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': UA } })
  } catch (err) {
    throw new Error(`no answer from SearXNG at ${url.host} (${err.message})`)
  }
  if (res.status === 403) throw new Error('SearXNG refused the JSON format — enable json in its settings.yml')
  if (!res.ok) throw new Error(`SearXNG answered ${res.status}`)

  const body = await res.json().catch(() => null)
  if (!body) throw new Error('SearXNG did not return JSON — enable json in its settings.yml')
  const results = Array.isArray(body.results) ? body.results : []
  return results.slice(0, count).map((r) => ({
    title: trimSnippet(r.title, 160) || hostOf(r.url) || r.url,
    url: r.url,
    snippet: trimSnippet(r.content),
  }))
}

/**
 * Run a search. Returns `{ query, provider, results }`, or throws with a message
 * worth showing the user — the tool turns that into text for the model.
 */
export async function webSearch(query, settings, count = 6) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('no query was given')

  const provider = settings?.provider ?? 'off'
  const limit = Math.min(Math.max(Number(count) || 6, 1), MAX_RESULTS)

  if (provider === 'off') throw new NotConfigured('web search is not configured')
  if (provider === 'brave') {
    if (!settings?.braveKey) throw new NotConfigured('no Brave API key is set')
    return { query: q, provider, results: await braveSearch(q, limit, settings.braveKey) }
  }
  if (provider === 'searxng') {
    if (!settings?.searxngUrl) throw new NotConfigured('no SearXNG address is set')
    return { query: q, provider, results: await searxSearch(q, limit, settings.searxngUrl) }
  }
  throw new NotConfigured(`unknown search provider: ${provider}`)
}
