// Fetch, verify and unpack an engine build.
//
// The download is deliberately not automatic: the caller starts it, and the
// progress object is polled by the UI. Nothing here runs on its own.

import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)

const LEMONADE_API = 'https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases/latest'
const OFFICIAL_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download'

/** Live progress, polled by the UI. One install at a time. */
export const progress = {
  phase: 'idle', // idle | resolving | downloading | verifying | extracting | done | error
  got: 0,
  total: 0,
  version: null,
  filename: null,
  verified: null,
  error: null,
}

function reset() {
  progress.phase = 'idle'
  progress.got = 0
  progress.total = 0
  progress.version = null
  progress.filename = null
  progress.verified = null
  progress.error = null
}

async function ghJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hearth' },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return res.json()
}

/**
 * Turn a catalog entry into a concrete download. Lemonade is resolved against
 * its latest release so the build stays current; the checksum comes from that
 * same release, so the pair is always coherent.
 */
export async function resolveAsset(source) {
  if (source.provider === 'lemonade') {
    const release = await ghJson(LEMONADE_API)
    const want = `windows-rocm-${source.gfx}-x64.zip`
    const asset = release.assets.find((a) => a.name.includes(want))
    if (!asset) throw new Error(`no ${source.gfx} archive in ${release.tag_name}`)

    const sums = release.assets.find((a) => a.name === 'checksums.txt')
    let sha256 = null
    if (sums) {
      const text = await (await fetch(sums.browser_download_url)).text()
      const line = text.split('\n').find((l) => l.includes(asset.name))
      sha256 = line?.trim().split(/\s+/)[0] ?? null
    }

    return {
      url: asset.browser_download_url,
      filename: asset.name,
      size: asset.size,
      sha256,
      version: release.tag_name,
    }
  }

  // The release tag is the build number, and it is already in the asset name.
  const tag = source.asset.match(/llama-(b\d+)/)?.[1]
  if (!tag) throw new Error(`cannot read a release tag from ${source.asset}`)

  return {
    url: `${OFFICIAL_BASE}/${tag}/${source.asset}`,
    filename: source.asset,
    size: null,
    sha256: source.sha256 ?? null,
    version: tag,
  }
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let got = 0

  for await (const chunk of res.body) {
    got += chunk.length
    hash.update(chunk)
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    onProgress(got, total)
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  return hash.digest('hex')
}

async function extract(archive, dest) {
  await mkdir(dest, { recursive: true })
  // Windows ships bsdtar, which reads zip. GNU tar (git-bash) does not, so the
  // system one is addressed explicitly rather than trusting PATH.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await run(tar, ['-xf', archive, '-C', dest], { timeout: 600000 })
}

/**
 * Download and install a build into `dest`. Resolves when the binary is in
 * place. Throws on any failure, leaving `progress.phase = 'error'`.
 */
export async function install(source, dest) {
  reset()
  try {
    progress.phase = 'resolving'
    const asset = await resolveAsset(source)
    progress.version = asset.version
    progress.filename = asset.filename
    progress.total = asset.size ?? 0

    await mkdir(dest, { recursive: true })
    const archive = join(dest, asset.filename)

    progress.phase = 'downloading'
    const actual = await download(asset.url, archive, (got, total) => {
      progress.got = got
      if (total) progress.total = total
    })

    progress.phase = 'verifying'
    if (asset.sha256) {
      if (actual !== asset.sha256) {
        throw new Error(`checksum mismatch: expected ${asset.sha256}, got ${actual}`)
      }
      progress.verified = true
    } else {
      // No published hash for this asset. Say so rather than implying safety.
      progress.verified = false
    }

    progress.phase = 'extracting'
    await extract(archive, dest)
    await rm(archive, { force: true })

    progress.phase = 'done'
    return { version: asset.version, verified: progress.verified, dir: dest }
  } catch (err) {
    progress.phase = 'error'
    progress.error = err.message
    throw err
  }
}

export async function isInstalled(dest, bin) {
  try {
    const s = await stat(join(dest, bin))
    return s.isFile()
  } catch {
    return false
  }
}

export { existsSync }
