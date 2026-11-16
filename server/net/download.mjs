// Streaming download over HTTP/1.1, with a sha256 computed as it goes.
//
// **Why not `fetch`.** undici negotiates HTTP/2 with the CDNs these files live on
// and leaves the h2 flow-control window at its 64 KB default. On a high-latency
// link that caps throughput at roughly window ÷ round-trip, and it is not a
// buffering problem on our side — a 4 MB pipe was no faster (1.27 MB/s). Measured
// on one machine against one file: **1.26 MB/s over h2, 24.6 MB/s over HTTP/1.1.**
// For the 4.6 GB default model that is an hour versus three minutes, on the first
// run of an app someone is still deciding whether to trust.
//
// **Why not plain `https.get`.** It does not follow redirects, and Hugging Face's
// `/resolve/` answers with a 302 to a CDN host. So the redirects are followed
// here, with a limit, and only http/https are allowed.
//
// The digest is returned rather than checked: what a digest is *for* differs per
// caller (engine, model, reranker each pin a different source), and the refusal
// belongs where the expectation lives.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const MAX_REDIRECTS = 5

function open(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('download failed: too many redirects'))
      return
    }

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`download failed: bad url ${url}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`download failed: unsupported protocol ${parsed.protocol}`))
      return
    }

    const lib = parsed.protocol === 'http:' ? http : https
    // 1 MB read buffer: large chunks mean fewer write syscalls, and the hash is
    // computed over the same bytes either way.
    const req = lib.get(url, { highWaterMark: 1 << 20 }, (res) => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        resolve(open(new URL(headers.location, url).toString(), redirects + 1))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed: HTTP ${statusCode}`))
        return
      }
      resolve(res)
    })
    req.on('error', (err) => reject(new Error(`download failed: ${err.message}`)))
  })
}

/**
 * Download `url` to `dest`, hashing as it streams.
 *
 * Resolves with the sha256 (hex). Rejects on any failure, leaving whatever
 * partial file exists for the caller to remove — every caller already does.
 */
export async function downloadToFile(url, dest, onProgress = () => {}) {
  const res = await open(url)
  const total = Number(res.headers['content-length'] ?? 0)
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let got = 0

  try {
    for await (const chunk of res) {
      got += chunk.length
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      onProgress(got, total)
    }
  } catch (err) {
    res.destroy()
    out.destroy()
    throw err
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  return hash.digest('hex')
}
