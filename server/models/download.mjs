// Fetch a chat model, verify it, and point the app at the folder.
//
// This is the missing step in a first run. The engine installer downloads
// llama.cpp, the reranker downloader fetches a reranker, and SearXNG installs
// itself — but nothing fetched a *chat* model, so a stranger's first run ended at
// a dropdown that said "no models" with no way forward that did not involve
// reading the source.
//
// Same rule as the other two: an unverified download is **refused**, not warned
// about. A GGUF is a file this app then loads and runs, so "we could not check
// it" has to be a stop.
//
// The digest is Hugging Face's published LFS oid for the file — the sha256 of the
// bytes — pinned here so a replaced file upstream is a failed download rather
// than a silent swap. The source is `ggml-org`, the llama.cpp project's own
// conversions, so the file a stranger gets is the one the engine's authors
// published rather than a re-quant of it.
//
// Measured on this machine: 4.59 GB, Q4_0, ~90 tok/s once loaded. Q4_0 rather
// than a K-quant because it is the smallest 4-bit in that repo and the point of
// the default is that it fits and it is quick; anyone who wants more quality
// points the app at their own folder.

import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { downloadToFile } from '../net/download.mjs'
import { markerMatches, readMarker, sha256File, writeMarker } from '../net/verify.mjs'
import { readConfig, writeConfig } from '../engine/resolve.mjs'

export const CATALOG = [
  {
    id: 'gemma-4-e4b-q4',
    name: 'Gemma 4 E4B',
    note: 'the fast default, fits an 8 GB card',
    file: 'gemma-4-E4B-it-Q4_0.gguf',
    url: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_0.gguf',
    sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
    size: 4590807392,
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

/**
 * Where downloaded chat models go.
 *
 * Its own folder rather than `data/models`, because that one already holds the
 * speech GGUFs in subfolders and the preset builder reads a folder flat — a
 * models dir that also contains a TTS tree is a folder whose listing is a lie.
 */
export function chatModelsDir(dataDir) {
  return join(dataDir, 'models', 'chat')
}

/**
 * Point the config at the folder — but only if nothing is set yet.
 *
 * A user who already has a models folder must not have it silently replaced by
 * ours: they asked for a file, not for a different library. Choosing is a
 * separate act, and the field is right there in the panel.
 */
function selectIfUnset(dataDir, dir) {
  const cfg = readConfig(dataDir)
  if (!cfg.modelsDir) writeConfig(dataDir, { modelsDir: dir })
}

function reset() {
  progress.phase = 'idle'
  progress.got = 0
  progress.total = 0
  progress.file = null
  progress.error = null
}

/**
 * Download one catalog entry into `data/models/chat` and make it the models dir.
 *
 * Resolves when the file is verified. Throws on any failure, leaving
 * `progress.phase = 'error'` and no partial file behind.
 */
export async function downloadModel(dataDir, id) {
  const entry = CATALOG.find((e) => e.id === id)
  if (!entry) throw new Error(`unknown model: ${id ?? 'none'}`)

  reset()
  const dir = chatModelsDir(dataDir)
  const dest = join(dir, entry.file)
  let partial = null

  try {
    await mkdir(dir, { recursive: true })

    // Already here at the right size. That is not the same as "the file we
    // pinned": a byte count says nothing about the bytes, which is how a
    // truncated copy passed as installed and got loaded. The marker beside the
    // file is the evidence, and it exists only when a digest has matched.
    if (existsSync(dest)) {
      const s = await stat(dest)
      if (s.size === entry.size) {
        if (markerMatches(entry, await readMarker(dir))) {
          progress.phase = 'done'
          progress.file = entry.file
          progress.got = s.size
          progress.total = entry.size
          selectIfUnset(dataDir, dir)
          return { path: dest, bytes: s.size, adopted: true }
        }

        // No proof: hash it once (~10 s for 4.6 GB) rather than pull the whole
        // file again. Matching writes the marker; a mismatch is refused and the
        // file is left where it is, because it may be something the user wanted.
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
        selectIfUnset(dataDir, dir)
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
    // 4.6 GB copy.
    await rm(dest, { force: true })
    await rename(partial, dest)
    partial = null

    await writeMarker(dir, entry)

    selectIfUnset(dataDir, dir)

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

/** What the panel shows: the catalog, which entries are on disk, and the models dir. */
export async function describeDownloads(dataDir) {
  const dir = chatModelsDir(dataDir)
  const entries = []
  // Read once: one marker per folder, matched per entry below.
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
      /** The marker's digest matched: the bytes on disk are the pinned bytes. */
      verified: markerMatches(entry, marker),
      bytes,
    })
  }
  return { dir, modelsDir: readConfig(dataDir).modelsDir ?? null, entries, progress }
}
