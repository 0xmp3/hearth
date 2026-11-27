// Fetch a reranker GGUF, verify it, and point the config at it.
//
// Same rule as the engine installer: an unverified download is **refused**, not
// warned about. A reranker is a file this app then loads and runs, so "we could
// not check it" has to be a stop rather than a note in a log.
//
// The digests are pinned here because Hugging Face publishes one per LFS file —
// the `lfs.oid` in the model API is the sha256 of the bytes. Pinning means a
// replaced file upstream is a failed download rather than a silent swap, and it
// is why this list is short and hand-checked rather than a search.
//
// Measured on this machine: bge-reranker-v2-m3-Q8_0 is 636 MB, loads in ~2 s, and
// reranks 10 candidates in ~350 ms on the CPU.

import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { downloadToFile } from '../net/download.mjs'
import { markerMatches, readMarker, sha256File, writeMarker } from '../net/verify.mjs'
import { rerankConfig, saveRerankConfig } from './index.mjs'

export const CATALOG = [
  {
    id: 'bge-reranker-v2-m3',
    name: 'bge-reranker-v2-m3',
    note: 'multilingual, the one this was measured with',
    file: 'bge-reranker-v2-m3-Q8_0.gguf',
    url: 'https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf',
    sha256: 'a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3',
    size: 635676416,
  },
  {
    id: 'jina-reranker-v2-base-multilingual',
    name: 'jina-reranker-v2-base-multilingual',
    note: 'half the size, same job, not measured here',
    file: 'jina-reranker-v2-base-multilingual-Q8_0.gguf',
    url: 'https://huggingface.co/gpustack/jina-reranker-v2-base-multilingual-GGUF/resolve/main/jina-reranker-v2-base-multilingual-Q8_0.gguf',
    sha256: '4dba405265ce8f00a4c6fa29d483585c11f5020ff37d61a1161c4e9be6348c18',
    size: 305339552,
  },
]

/** Live progress, polled by the UI. One download at a time. */
export const progress = {
  phase: 'idle', // idle | downloading | verifying | done | error
  got: 0,
  total: 0,
  file: null,
  error: null,
}

export function rerankerDir(dataDir) {
  return join(dataDir, 'models', 'reranker')
}

/**
 * Point the config at a downloaded model — but only if nothing is selected yet.
 *
 * Downloading a second reranker must not silently replace the one in use: the
 * user asked for a file, not for a different search order. Choosing is a
 * separate click ("use this"), which is also what makes the two buttons honest.
 */
function selectIfUnset(dataDir, path) {
  const current = rerankConfig(dataDir).model
  if (!current || current === path) saveRerankConfig(dataDir, { model: path, enabled: true })
}

function reset() {
  progress.phase = 'idle'
  progress.got = 0
  progress.total = 0
  progress.file = null
  progress.error = null
}

/**
 * Download one catalog entry into `data/models/reranker` and make it the model.
 *
 * Resolves when the file is verified and the config points at it. Throws on any
 * failure, leaving `progress.phase = 'error'` and no partial file behind.
 */
export async function downloadReranker(dataDir, id) {
  const entry = CATALOG.find((e) => e.id === id)
  if (!entry) throw new Error(`unknown reranker: ${id ?? 'none'}`)

  reset()
  const dir = rerankerDir(dataDir)
  const dest = join(dir, entry.file)
  let partial = null

  try {
    await mkdir(dir, { recursive: true })

    // Already here at the right size — but a byte count is not evidence about
    // the bytes, so the marker decides. No marker means hash it once; matching
    // writes the marker, and a mismatch is refused with the file left in place.
    if (existsSync(dest)) {
      const s = await stat(dest)
      if (s.size === entry.size) {
        if (markerMatches(entry, await readMarker(dir))) {
          progress.phase = 'done'
          progress.file = entry.file
          progress.got = s.size
          progress.total = entry.size
          selectIfUnset(dataDir, dest)
          return { path: dest, bytes: s.size, adopted: true }
        }

        progress.phase = 'verifying'
        progress.file = entry.file
        progress.got = 0
        progress.total = s.size
        const found = await sha256File(dest, (read) => {
          progress.got = read
        })
        if (found !== entry.sha256) {
          throw new Error(
            `${entry.file} is not the file Hearth pins (expected ${entry.sha256}, found ${found}). ` +
              'It was left in place — delete it, or download it again.',
          )
        }
        await writeMarker(dir, entry, { verifiedBy: 'hash-on-adopt' })
        progress.phase = 'done'
        progress.got = s.size
        selectIfUnset(dataDir, dest)
        return { path: dest, bytes: s.size, adopted: true }
      }
    }

    progress.phase = 'downloading'
    progress.file = entry.file
    progress.total = entry.size
    partial = `${dest}.part`

    const actual = await downloadToFile(entry.url, partial, (got, total) => {
      progress.got = got
      if (total) progress.total = total
    })

    progress.phase = 'verifying'
    if (actual !== entry.sha256) {
      throw new Error(`checksum mismatch: expected ${entry.sha256}, got ${actual}`)
    }

    // Rename only after the digest matches, so a half-written file can never be
    // mistaken for a model. Same directory, so this is a rename rather than a
    // 636 MB copy through memory.
    await rm(dest, { force: true })
    await rename(partial, dest)
    partial = null

    await writeMarker(dir, entry)

    selectIfUnset(dataDir, dest)

    progress.phase = 'done'
    return { path: dest, bytes: entry.size, adopted: false }
  } catch (err) {
    progress.phase = 'error'
    progress.error = err.message
    throw err
  } finally {
    if (partial) await rm(partial, { force: true }).catch(() => {})
  }
}

/** What the panel shows: the catalog, and which entries are already on disk. */
export async function describeDownloads(dataDir) {
  const dir = rerankerDir(dataDir)
  const entries = []
  const marker = await readMarker(dir)
  for (const entry of CATALOG) {
    const path = join(dir, entry.file)
    let bytes = 0
    try {
      bytes = (await stat(path)).size
    } catch {}
    entries.push({
      id: entry.id,
      name: entry.name,
      note: entry.note,
      file: entry.file,
      path,
      size: entry.size,
      installed: bytes === entry.size,
      verified: markerMatches(entry, marker),
      bytes,
    })
  }
  return { dir, entries, progress }
}
