// The evidence that a file on disk is the file the catalog pinned.
//
// Both downloaders used to adopt a file for the wrong reason: right byte count,
// therefore ours. Size proves nothing about content — a file truncated to the
// catalog's number passed as "installed", and the app then loaded it. The
// marker beside the file is the proof instead: it is written only after a
// sha256 has matched, and reading it is instant.
//
// A file with no marker (an install from before markers existed, or one the
// user dropped in) is hashed once. That is seconds for a 4.6 GB model and it
// happens on the verification path only — never on a status poll, which must
// stay cheap enough for the panel to ask on every open.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MARKER = '.installed.json'

/**
 * Does this marker prove the entry's bytes?
 *
 * Only the digest counts. `id` and `file` are checked when present, because a
 * marker naming a different file is a marker for a different file — but a
 * missing `file` is not a failure: markers written before this module existed
 * carry the digest, which is the part that matters.
 */
export function markerMatches(entry, marker) {
  if (!marker || typeof marker !== 'object') return false
  if (typeof marker.sha256 !== 'string') return false
  if (marker.sha256.trim().toLowerCase() !== String(entry.sha256).toLowerCase()) return false
  if (marker.file !== undefined && marker.file !== entry.file) return false
  if (marker.id !== undefined && marker.id !== entry.id) return false
  return true
}

/** The marker beside a directory's files, or null when there is none to read. */
export async function readMarker(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MARKER), 'utf8'))
  } catch {
    // Absent or unparseable both mean "no proof", which is not an error.
    return null
  }
}

/** Write the marker. Call it only after a digest has matched. */
export async function writeMarker(dir, entry, extra = {}) {
  const body = {
    id: entry.id,
    file: entry.file,
    sha256: entry.sha256,
    ...extra,
    installedAt: new Date().toISOString(),
  }
  await writeFile(join(dir, MARKER), JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/** sha256 of a file on disk, streamed, with a byte counter for the progress bar. */
export function sha256File(path, onBytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let read = 0
    createReadStream(path)
      .on('data', (chunk) => {
        read += chunk.length
        hash.update(chunk)
        onBytes?.(read)
      })
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
