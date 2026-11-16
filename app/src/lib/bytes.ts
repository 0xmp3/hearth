// Byte sizes, in the units a person reads.
//
// Decimal (1000), not binary (1024), because that is how model files are quoted
// everywhere they are published — Hugging Face says 4.59 GB for a file Windows
// would call 4.28 GiB, and a panel that disagrees with the page the user just
// came from reads as a bug.
//
// One decimal, and no pointless `.0` — the same rule as `formatTokens`: "4.6 GB"
// is a size, "4.59 GB" is a measurement, and "4.0 GB" is a bug that makes the
// number look computed rather than chosen.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  // Bytes are whole; everything above them gets one decimal at most.
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${UNITS[unit]}`
}
