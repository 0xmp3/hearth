// Reply budget stops. A linear slider from 256 to 1M is unusable — almost the
// whole range sits in the top few percent — so the slider moves over these.
export const BUDGET_STOPS = [
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
]

export function nearestStopIndex(value: number): number {
  let best = 0
  let bestDelta = Infinity
  BUDGET_STOPS.forEach((stop, i) => {
    const delta = Math.abs(stop - value)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  })
  return best
}

export function formatTokens(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}
