// Fetch one page and hand back text.
//
// This is the only place in Hearth that talks to the internet, and it is behind
// the manager's loopback guard, the user's network switch, and `guard.mjs`.
// The app never egresses on its own: a browser page that could fetch arbitrary
// URLs would leak the user's IP and cookies to whatever the model named.

import { checkHost, checkUrl, Refused } from './guard.mjs'
import { extractTitle, htmlToText, plainToText } from './extract.mjs'

const TIMEOUT_MS = 12000
const MAX_BYTES = 3 * 1024 * 1024
const MAX_REDIRECTS = 3
const DEFAULT_CHARS = 12000
const MAX_CHARS = 40000

const UA =
  'Hearth/0.1 (local app; +https://github.com/) ' +
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const TEXTUAL = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
  'text/csv',
]

function typeOf(contentType) {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

/** Read at most `limit` bytes, then stop pulling. */
async function readCapped(res, limit) {
  const reader = res.body?.getReader()
  if (!reader) return { text: '', bytes: 0, truncated: false }
  const chunks = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (bytes - limit))))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: buf.toString('utf8'), bytes: buf.byteLength, truncated }
}

function decode(bufText, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType ?? '')
  const charset = (m?.[1] ?? 'utf-8').toLowerCase()
  if (charset === 'utf-8' || charset === 'utf8') return bufText
  try {
    return new TextDecoder(charset).decode(Buffer.from(bufText, 'utf8'))
  } catch {
    // An unknown charset is not worth a failure: utf-8 is right for the web.
    return bufText
  }
}

/**
 * Fetch a URL and return `{ url, title, text, contentType, bytes, truncated }`.
 * Throws `Refused` for anything this app will not fetch, and plain errors for
 * anything the network would not do.
 */
export async function readUrl(input, opts = {}) {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || DEFAULT_CHARS, 500), MAX_CHARS)
  const signal = AbortSignal.timeout(TIMEOUT_MS)

  let url = checkUrl(input)
  let res = null
  let hops = 0

  for (;;) {
    await checkHost(url)
    res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en;q=0.9',
      },
    })

    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (++hops > MAX_REDIRECTS) throw new Refused('too many redirects')
      await res.body?.cancel().catch(() => {})
      // Relative Locations resolve against the URL we just asked for, and the
      // next hop is checked from scratch — this is the hop that would otherwise
      // walk a public host into 127.0.0.1.
      url = checkUrl(new URL(location, url).toString())
      continue
    }
    break
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`the page answered ${res.status} ${res.statusText}`.trim())
  }

  const contentType = typeOf(res.headers.get('content-type'))
  if (contentType && !TEXTUAL.includes(contentType)) {
    await res.body?.cancel().catch(() => {})
    throw new Refused(`${contentType} is not text — only pages and plain files can be read`)
  }

  const raw = await readCapped(res, MAX_BYTES)
  const html = decode(raw.text, res.headers.get('content-type'))

  let title = ''
  let text = ''
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml' || /<html/i.test(html.slice(0, 2000))) {
    title = extractTitle(html)
    text = htmlToText(html, maxChars)
  } else {
    text = plainToText(html, maxChars)
  }

  return {
    url: url.toString(),
    title,
    text,
    contentType,
    bytes: raw.bytes,
    truncated: raw.truncated || text.includes('characters omitted'),
  }
}
