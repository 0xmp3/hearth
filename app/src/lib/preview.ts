// Turning a reply into a page.
//
// A model asked for "a webpage" answers with fenced blocks — usually one `html`
// block, sometimes `html` + `css` + `js` split apart. This module finds those
// blocks, assembles them into one document, and wraps a bare fragment in a
// minimal page. It does not render anything: the panel owns the iframe, and the
// sandbox is what makes the result safe to run.
//
// The security shape lives here because the document is built here:
//
//   * a CSP meta tag is the first thing in <head>, so the page cannot fetch,
//     post a form, open a socket or load a remote asset;
//   * nothing external is ever inlined or proxied — a page that asks for
//     cdn.tailwindcss.com renders blank, and `external` says why;
//   * the iframe that receives this is sandboxed without `allow-same-origin`,
//     so the document's origin is opaque and the app's IndexedDB, localStorage
//     and the manager are all out of reach. That is the panel's job, not this
//     file's, but the two only work together.

/**
 * The policy every preview runs under.
 *
 * `connect-src 'none'` is the one that matters most: without it a page could
 * POST a conversation to anywhere it liked. `form-action` and `base-uri` close
 * the two channels that do not go through fetch. `img-src data: blob:` keeps
 * inline images working while refusing a remote pixel, which is the classic
 * one-bit exfiltration trick.
 */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'"

export type PreviewDoc = {
  /** The complete document, CSP included. Goes straight into `srcdoc`. */
  html: string
  /** A label for the panel header: the page's own <title>, or a fallback. */
  title: string
  /** Hosts the page asks for that the CSP will refuse. Empty is the good case. */
  external: string[]
  /** How many fenced blocks went into the document. */
  blocks: number
}

/** Languages that mean "this is the page", "this is its style", "this is its script". */
const HTML_LANGS = new Set(['html', 'htm', 'xhtml'])
const CSS_LANGS = new Set(['css'])
const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'jsx'])

type Block = { lang: string; body: string }

/**
 * Fenced blocks, in order. Deliberately the same shape `tidy()` in Markdown.tsx
 * splits on, so what the panel renders is what the code block showed.
 */
function fences(text: string): Block[] {
  const out: Block[] = []
  const re = /```([^\n`]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({ lang: m[1].trim().toLowerCase().split(/\s+/)[0] ?? '', body: m[2] })
  }
  return out
}

/**
 * A page's own title, if it declares one. Used for the panel header so a reply
 * with three pages is not three identical tabs.
 *
 * Deliberately <title> only. A fragment's first heading looks like a title but
 * is not one — a counter page's <h1> is the number — and a wrong title is worse
 * than a plain one.
 */
function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const text = m?.[1].replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 80) : ''
}

/**
 * Hosts the document asks for. Not a security control — the CSP is — but the
 * panel needs to say *why* a Tailwind page came up blank, and "it asked for
 * cdn.tailwindcss.com" is the whole answer.
 */
function externalHosts(html: string): string[] {
  const hosts = new Set<string>()
  const patterns = [
    /(?:src|href|poster)\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>]+)/gi,
    /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/([^/"'\s)]+)/gi,
    /url\(\s*["']?(?:https?:)?\/\/([^/"'\s)]+)/gi,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) hosts.add(m[1].toLowerCase())
  }
  return [...hosts].sort()
}

/**
 * The base stylesheet for a wrapped fragment.
 *
 * These are literal values on purpose: this is a document we generate for
 * someone else's page, not app chrome, so the theme contract does not apply.
 * It follows the OS colour scheme rather than Hearth's theme, because a page
 * the model wrote should look like a page, not like this app.
 */
const BASE_CSS = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body {
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 16px;
  max-width: 100%;
  overflow-wrap: break-word;
}
img, svg, canvas, video { max-width: 100%; height: auto; }
`

/**
 * Navigation the document declares itself, removed at assembly.
 *
 * `<meta http-equiv="refresh">` is not governed by any CSP directive, so the one
 * form of it we can delete is the form we are handed. Script-driven navigation is
 * left to the panel's load-event check, because nothing at this layer can
 * intercept `location = …` either.
 */
function stripMetaRefresh(html: string): string {
  return html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')
}

function cspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
}

/** A fragment with no <html> of its own, given the smallest page that works. */
function wrap(body: string, css: string, js: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${cspMeta()}
<style>${BASE_CSS}${css}</style>
</head>
<body>
${body}
${js ? `<script>${js}</script>` : ''}
</body>
</html>`
}

/**
 * Put the CSP first in <head>, and the extra blocks where they belong.
 *
 * A model's document often has a <head> already, sometimes with its own meta
 * CSP. Ours goes first and both apply — CSP policies intersect, so a page
 * cannot loosen the policy by declaring a second one.
 */
function assemble(doc: string, css: string, js: string): string {
  let out = doc

  const head = /<head[^>]*>/i.exec(out)
  if (head) {
    const at = head.index + head[0].length
    out = out.slice(0, at) + `\n${cspMeta()}\n<style>${css}</style>\n` + out.slice(at)
  } else if (/<html[^>]*>/i.test(out)) {
    // <html> but no <head>: give it one, right after the opening tag.
    out = out.replace(/<html[^>]*>/i, (tag) => `${tag}\n<head>\n${cspMeta()}\n<style>${css}</style>\n</head>`)
  } else {
    // No <html> at all — the caller wraps, so this is only reachable for a
    // document that starts with <body> or a doctype and nothing else.
    out = `${cspMeta()}\n<style>${css}</style>\n${out}`
  }

  if (js) {
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `<script>${js}</script>\n</body>`)
    else out += `\n<script>${js}</script>`
  }

  return out
}

/**
 * The page in a reply, or null.
 *
 * The trigger is the explicit signal — a fenced `html` block — not a guess at
 * prose. A reply that merely mentions HTML is a reply, not a page.
 */
export function extractPreview(text: string): PreviewDoc | null {
  if (!text || !text.includes('```')) return null

  const blocks = fences(text)
  const htmlBlocks = blocks.filter((b) => HTML_LANGS.has(b.lang))
  if (!htmlBlocks.length) return null

  const css = blocks
    .filter((b) => CSS_LANGS.has(b.lang))
    .map((b) => b.body)
    .join('\n')
  const js = blocks
    .filter((b) => JS_LANGS.has(b.lang))
    .map((b) => b.body)
    .join('\n;\n')

  // The first html block is the page. A second one is a second example, and
  // merging two documents produces neither. Any refresh the document declares is
  // stripped here — it is the one navigation form we can remove rather than watch.
  const base = stripMetaRefresh(htmlBlocks[0].body)
  const full = /<html[\s>]/i.test(base)
  const html = full ? assemble(base, css, js) : wrap(base, css, js)

  return {
    html,
    title: titleOf(html) || 'preview',
    external: externalHosts(html),
    blocks: htmlBlocks.length + (css ? 1 : 0) + (js ? 1 : 0),
  }
}
