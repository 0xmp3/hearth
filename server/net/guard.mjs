// What the manager will and will not fetch.
//
// The URL is chosen by a model, so this is where the model is refused access to
// the machine it is running on: no loopback, no link-local, no private ranges,
// no metadata services, no file://. Every redirect hop is checked again, because
// a public host is free to redirect to 127.0.0.1.
//
// Residual risk, stated plainly: between this check and the fetch, DNS can
// answer differently (rebinding). Closing that needs the connection pinned to
// the validated address, which node's global fetch does not expose. For a local
// single-user app whose egress the user has already switched on, the
// proportionate defence is this check plus per-hop re-checks.

import { lookup } from 'node:dns/promises'

const PRIVATE_V4 = [
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^192\.168\./, 'private'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, 'carrier-grade NAT'],
  [/^192\.0\.0\./, 'IETF-reserved'],
  [/^198\.18\./, 'benchmarking'],
  [/^22[4-9]\./, 'multicast'],
  [/^23\d\./, 'multicast'],
  [/^2[4-5]\d\./, 'reserved'],
]

const BLOCKED_HOSTS = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i]

export class Refused extends Error {}

function privateV4(ip) {
  return PRIVATE_V4.find(([re]) => re.test(ip))?.[1] ?? null
}

function privateV6(ip) {
  const addr = ip.toLowerCase()
  if (addr === '::1' || addr === '::') return 'loopback'
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return 'link-local'
  }
  if (addr.startsWith('fc') || addr.startsWith('fd')) return 'unique-local'
  // ::ffff:127.0.0.1 — a v4 address wearing a v6 coat.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return privateV4(mapped[1])
  return null
}

/** Parse and vet a URL the model asked for. Returns the URL object. */
export function checkUrl(input) {
  let url
  try {
    url = new URL(String(input).trim())
  } catch {
    throw new Refused('that is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Refused(`only http and https are fetched, not ${url.protocol.replace(':', '')}`)
  }
  if (!url.hostname) throw new Refused('that URL has no host')
  if (BLOCKED_HOSTS.some((re) => re.test(url.hostname))) {
    throw new Refused(`${url.hostname} is this machine`)
  }
  // A literal address skips DNS, so check it here as well.
  const literal = privateV4(url.hostname) ?? privateV6(url.hostname.replace(/^\[|\]$/g, ''))
  if (literal) throw new Refused(`${url.hostname} is a ${literal} address`)
  return url
}

/**
 * Resolve the hostname and refuse if *any* answer is private. Checking every
 * answer rather than the first stops a host that answers with one public and
 * one private record from slipping through.
 */
export async function checkHost(url) {
  let answers
  try {
    answers = await lookup(url.hostname, { all: true, verbatim: true })
  } catch (err) {
    throw new Refused(`could not resolve ${url.hostname} (${err.code ?? err.message})`)
  }
  if (!answers.length) throw new Refused(`could not resolve ${url.hostname}`)
  for (const { address } of answers) {
    const bad = address.includes(':') ? privateV6(address) : privateV4(address)
    if (bad) throw new Refused(`${url.hostname} resolves to a ${bad} address`)
  }
  return answers
}
