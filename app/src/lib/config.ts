// Where llama-server lives.
//
// A constant was right while the app and the model were on the same machine. A
// test VM changes that: the app runs in the guest, the model stays on the host,
// and this is the one setting that has to cross the boundary. Read once at
// boot, so changing it reloads — a live-swapping base URL would leave streams
// pointed at the wrong host.
const KEY = 'hearth.backend'

export const DEFAULT_BACKEND = 'http://127.0.0.1:8088'

function read(): string {
  try {
    return localStorage.getItem(KEY)?.trim() || DEFAULT_BACKEND
  } catch {
    return DEFAULT_BACKEND
  }
}

export const BASE_URL = read()

/** Persist a new backend address. Returns false if it is not an http(s) URL. */
export function setBackendUrl(url: string): boolean {
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  try {
    localStorage.setItem(KEY, url.trim().replace(/\/$/, ''))
  } catch {
    return false
  }
  location.reload()
  return true
}
export const SYSTEM_PROMPT = ''

// Reasoning models spend tokens thinking before they answer. 1024 was enough
// to let one think itself to a standstill and return nothing at all.
export const MAX_TOKENS = 2048
