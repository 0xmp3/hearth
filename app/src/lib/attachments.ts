// Turning a picked file into something a model can receive.
//
// Two kinds, because they travel differently:
//
//   text   read in the browser and inlined into the prompt. No index, no
//          retrieval — the whole file goes in the message. Honest and simple,
//          and it fails loudly at large files rather than silently.
//   image  uploaded to the manager and sent as a multimodal content part. Only
//          works when the server was started with a vision projector.

import { uploadImage } from './upload'

export type Attachment = {
  id: string
  name: string
  kind: 'image' | 'text'
  mime: string
  size: number
  /** Manager URL, for images. */
  url?: string
  /** Extracted text, for documents. */
  text?: string
  /** The file was longer than the budget and was cut. */
  truncated?: boolean
}

// Anything a model can read as plain text. Extensions matter more than MIME
// types here: browsers report an empty type for most source files.
const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|yml|yaml|toml|ini|cfg|conf|xml|html|htm|css|scss|js|jsx|mjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|bat|sql|env|gitignore)$/i

/** Roughly 25k tokens. Past this the file stops being context and starts being a bill. */
const MAX_TEXT_CHARS = 100_000

export function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * Extract text from a PDF.
 *
 * pdfjs is imported lazily so the ~1 MB parser is only fetched when someone
 * actually attaches a PDF — the app's first load stays as small as it was.
 */
async function readPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default

  const task = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const doc = await task.promise
  const pages: string[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) pages.push(text)
  }

  // The loading task owns teardown; the document proxy does not.
  await task.destroy()
  return pages.join('\n\n')
}

export function isTextLike(file: File) {
  return (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    TEXT_EXT.test(file.name)
  )
}

export function isSupported(file: File) {
  return file.type.startsWith('image/') || isPdf(file) || isTextLike(file)
}

export async function readAttachment(file: File): Promise<Attachment> {
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
  }

  if (file.type.startsWith('image/')) {
    const { url } = await uploadImage(file, 'attachment')
    return { ...base, kind: 'image', url }
  }

  if (isPdf(file)) {
    const raw = await readPdf(file)
    if (!raw.trim()) {
      throw new Error(`${file.name}: no text found — it may be a scanned PDF`)
    }
    const truncated = raw.length > MAX_TEXT_CHARS
    return {
      ...base,
      kind: 'text',
      text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
      truncated,
    }
  }

  if (isTextLike(file)) {
    const raw = await file.text()
    const truncated = raw.length > MAX_TEXT_CHARS
    return {
      ...base,
      kind: 'text',
      text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
      truncated,
    }
  }

  throw new Error(`${file.name}: unsupported file type`)
}

/** Read a stored image back into a data URL, which is what the API accepts. */
export async function toDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  // The <img> that displays this file loaded it in no-cors mode, and the browser
  // caches that opaque response. A later CORS fetch of the same URL is then
  // rejected, so the request is made unique.
  const bust = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
  const res = await fetch(bust)
  if (!res.ok) throw new Error(`could not read ${url}`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
