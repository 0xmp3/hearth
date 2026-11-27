// The rule that decides whether a file on disk is the file the catalog pinned.
//
// This is the check that used to be missing: adoption compared byte counts, so a
// truncated copy or any file padded to the right length counted as installed and
// was then loaded. The marker is the evidence, and it only ever exists after a
// sha256 has matched — which is why these tests are about identity, not size.
//
// The downloaders themselves need a live network and a real 305 MB GGUF, so the
// branch they share is tested here; the end-to-end adoption path is proved with
// scripts in the session notes rather than in the unit suite.

import { describe, expect, it } from 'vitest'
import { markerMatches } from '../../../server/net/verify.mjs'

const entry = {
  id: 'bge-reranker-v2-m3',
  file: 'bge-reranker-v2-m3-Q8_0.gguf',
  sha256: 'a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3',
  size: 635676416,
}

describe('markerMatches', () => {
  it('accepts a marker written for this entry', () => {
    expect(markerMatches(entry, { id: entry.id, file: entry.file, sha256: entry.sha256 })).toBe(true)
  })

  it('accepts a marker without id or file, because the digest is the proof', () => {
    expect(markerMatches(entry, { sha256: entry.sha256, installedAt: '2026-11-15T00:00:00.000Z' })).toBe(true)
  })

  it('ignores hex case, since digests are compared as text', () => {
    expect(markerMatches(entry, { sha256: entry.sha256.toUpperCase() })).toBe(true)
  })

  it('refuses a marker for a different file in the same folder', () => {
    expect(
      markerMatches(entry, {
        id: 'jina-reranker-v2-base-multilingual',
        file: 'jina-reranker-v2-base-multilingual-Q8_0.gguf',
        sha256: '4dba405265ce8f00a4c6fa29d483585c11f5020ff37d61a1161c4e9be6348c18',
      }),
    ).toBe(false)
  })

  it('refuses a marker whose digest differs', () => {
    expect(markerMatches(entry, { sha256: '0'.repeat(64) })).toBe(false)
  })

  it('refuses a marker that names this digest but a different file', () => {
    expect(markerMatches(entry, { file: 'something-else.gguf', sha256: entry.sha256 })).toBe(false)
  })

  it('refuses absent, unparsed and malformed markers', () => {
    expect(markerMatches(entry, null)).toBe(false)
    expect(markerMatches(entry, undefined)).toBe(false)
    expect(markerMatches(entry, {})).toBe(false)
    expect(markerMatches(entry, { sha256: 42 })).toBe(false)
    expect(markerMatches(entry, 'a43c7c9b')).toBe(false)
  })
})
