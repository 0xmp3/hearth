// HTML → readable text, with no dependencies.
//
// The point is not a perfect reader mode. It is that a page arrives as text a
// model can actually use: the article, not the navigation, the cookie banner,
// the footer and 400 KB of JavaScript. A dependency would do better — and would
// also be a supply-chain surface in the one file that parses hostile input, for
// a job that is a hundred lines of careful stripping.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
}

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // Control characters and lone surrogates are noise, not text.
      if (!Number.isFinite(code) || code < 32 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return ''
      try {
        return String.fromCodePoint(code)
      } catch {
        return ''
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function meta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  )
  const m = html.match(re)
  if (m) return decodeEntities(m[1]).trim()
  // Attribute order is not guaranteed to be name-then-content.
  const rev = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`,
    'i',
  )
  const m2 = html.match(rev)
  return m2 ? decodeEntities(m2[1]).trim() : ''
}

/** The <title>, og:title, or the first <h1>. */
export function extractTitle(html) {
  const og = meta(html, 'og:title')
  if (og) return og
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title) {
    const t = decodeEntities(title[1]).replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1) return decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return ''
}

/**
 * Pick the part of the document that is the content. `<article>` and `<main>`
 * are the honest signals; everything else is a guess about a page nobody
 * structured, and the whole body is the better guess then.
 */
function mainRegion(html) {
  for (const tag of ['article', 'main']) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
    const m = html.match(re)
    if (m && m[1].length > 400) return m[1]
  }
  const role = html.match(/<div[^>]+role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/i)
  if (role && role[1].length > 400) return role[1]
  return html
}

const DROP = /<(script|style|noscript|svg|iframe|template|canvas|form|nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1>/gi

const BLOCK_NAMES = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'thead', 'tbody', 'td', 'th',
  'blockquote', 'pre', 'figure', 'figcaption', 'br', 'hr', 'details', 'summary',
])

/**
 * Replace every tag with nothing, or with a newline when it is a block.
 *
 * A scanner rather than a regex, and not out of taste: Wikipedia carries its
 * template source in `data-mw` attributes, those attributes contain quotes and
 * braces and occasionally an apostrophe in prose, and every regex that tries to
 * match a tag in the face of that eventually stops in the wrong place and leaves
 * the JSON behind as text. Walking the string, one `<` at a time and one quoted
 * run at a time, has no such failure.
 */
function stripTags(html) {
  let out = ''
  let i = 0
  const n = html.length

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    const next = html[lt + 1]
    const isTag = next === '!' || next === '?' || next === '/' || (next !== undefined && /[a-zA-Z]/.test(next))
    if (!isTag) {
      // A `<` in prose ("a < b") is text, not a tag.
      out += '<'
      i = lt + 1
      continue
    }

    let j = lt + 1
    let quote = null
    while (j < n) {
      const c = html[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      j++
    }
    if (j >= n) break // unterminated tag: the rest is not text worth keeping

    const m = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, j + 1))
    if (m && BLOCK_NAMES.has(m[1].toLowerCase())) out += '\n'
    i = j + 1
  }

  return out
}

/**
 * Structured text from an HTML document, capped.
 *
 * Lines are rebuilt rather than collapsed so headings and list items survive as
 * their own lines — a model reading a spec loses less from `## heading` than
 * from a paragraph of run-on sentences.
 */
export function htmlToText(html, limit = 40000) {
  let body = mainRegion(html)
  body = body.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(DROP, ' ')
  body = stripTags(body)
  body = decodeEntities(body)
  body = body.replace(/\r/g, '')
  body = body.replace(/[ \t\f\v\u00a0]+/g, ' ')
  body = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join('\n')
  body = body.replace(/\n{3,}/g, '\n\n').trim()

  if (body.length > limit) {
    // Head and tail: the opening says what the page is, the end often has the
    // numbers people asked for.
    const head = Math.floor(limit * 0.8)
    const tail = limit - head
    body = `${body.slice(0, head)}\n\n[… ${body.length - limit} characters omitted …]\n\n${body.slice(-tail)}`
  }
  return body
}

/** Plain text or JSON: still worth capping and normalising. */
export function plainToText(text, limit = 40000) {
  const body = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (body.length <= limit) return body
  const head = Math.floor(limit * 0.8)
  return `${body.slice(0, head)}\n\n[… ${body.length - limit} characters omitted …]\n\n${body.slice(-(limit - head))}`
}
