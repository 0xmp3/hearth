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

/**
 * One decimal place, but no pointless `.0`.
 *
 * The condition used to be "is it an exact multiple", which is the wrong
 * question: 1024 is not a multiple of 1000, so it rendered as `1.0k` — the
 * label for the most common stops in the list. Format first, then drop the
 * zero.
 */
function short(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '')
}

export function formatTokens(n: number): string {
  if (n >= 1048576) return `${short(n / 1048576)}M`
  if (n >= 1000) return `${short(n / 1000)}k`
  return String(n)
}
