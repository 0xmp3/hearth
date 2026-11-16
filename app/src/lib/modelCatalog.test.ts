// The download catalog, checked as data.
//
// A typo in a digest is invisible until 4.6 GB have arrived and the checksum
// fails — which is the worst possible time to learn it. These assertions are
// cheap and they run on every push.

import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../../server/models/download.mjs'

describe('chat model catalog', () => {
  it('has at least one entry', () => {
    expect(CATALOG.length).toBeGreaterThan(0)
  })

  it('pins a real sha256 for every entry', () => {
    for (const entry of CATALOG) {
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('pins a size, and a URL that ends in the file it names', () => {
    for (const entry of CATALOG) {
      expect(entry.size, entry.id).toBeGreaterThan(0)
      expect(entry.url.endsWith(`/${entry.file}`), entry.id).toBe(true)
      expect(entry.file.endsWith('.gguf'), entry.id).toBe(true)
    }
  })

  it('fetches from Hugging Face over https, not from a mirror', () => {
    for (const entry of CATALOG) {
      const url = new URL(entry.url)
      expect(url.protocol).toBe('https:')
      expect(url.hostname).toBe('huggingface.co')
    }
  })

  it('has unique ids and file names', () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length)
    expect(new Set(CATALOG.map((e) => e.file)).size).toBe(CATALOG.length)
  })
})
