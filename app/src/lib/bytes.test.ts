import { describe, expect, it } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('shows bytes as whole numbers', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('steps up at 1000, the way model files are published', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(1500)).toBe('1.5 KB')
    // Hugging Face calls this file 4.59 GB; the panel must not say 4.3.
    expect(formatBytes(4590807392)).toBe('4.6 GB')
  })

  it('drops a pointless .0', () => {
    expect(formatBytes(1000 * 1000 * 1000)).toBe('1 GB')
  })

  it('survives nonsense without printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })
})
