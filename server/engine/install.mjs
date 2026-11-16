// Fetch, verify and unpack an engine build.
//
// The download is deliberately not automatic: the caller starts it, and the
// progress object is polled by the UI. Nothing here runs on its own.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { downloadToFile } from '../net/download.mjs'
import { MARKER } from './resolve.mjs'

const run = promisify(execFile)

const LEMONADE_API = 'https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases/latest'
const OFFICIAL_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download'
const OFFICIAL_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/tags'

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

  // ggml-org publishes no checksums.txt, but GitHub publishes a sha256 digest
  // per release asset, so the pair is anchored on the same thing lemonade's is:
  // the release itself. A catalog entry may still pin its own hash and win.
  let size = null
  let sha256 = source.sha256 ?? null
  try {
    const release = await ghJson(`${OFFICIAL_API}/${tag}`)
    const asset = release.assets?.find((a) => a.name === source.asset)
    if (asset) {
      size = asset.size ?? null
      const digest = String(asset.digest ?? '')
      if (digest.startsWith('sha256:')) sha256 = digest.slice('sha256:'.length)
    }
  } catch (err) {
    // Without a pinned hash this is fatal: install() refuses an unverified
    // download, and failing here says why.
    if (!sha256) throw new Error(`could not read the ${tag} release metadata: ${err.message}`)
  }

  return {
    url: `${OFFICIAL_BASE}/${tag}/${source.asset}`,
    filename: source.asset,
    size,
    sha256,
    version: tag,
  }
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
 *
 * An unverified download is **refused**, not warned about: this function's whole
 * job is to put an executable on the user's disk, so "we could not check it" has
 * to be a stop. A build with no digest anywhere is a bug in the catalog, not a
 * reason to run an unverified binary.
 */
export async function install(source, dest) {
  reset()
  let archive = null
  try {
    progress.phase = 'resolving'
    const asset = await resolveAsset(source)
    progress.version = asset.version
    progress.filename = asset.filename
    progress.total = asset.size ?? 0

    if (!asset.sha256) {
      throw new Error(
        `no checksum is available for ${asset.filename} — refusing to unpack an unverified build`,
      )
    }

    await mkdir(dest, { recursive: true })
    archive = join(dest, asset.filename)

    progress.phase = 'downloading'
    const actual = await downloadToFile(asset.url, archive, (got, total) => {
      progress.got = got
      if (total) progress.total = total
    })

    progress.phase = 'verifying'
    if (actual !== asset.sha256) {
      throw new Error(`checksum mismatch: expected ${asset.sha256}, got ${actual}`)
    }
    progress.verified = true

    progress.phase = 'extracting'
    await extract(archive, dest)

    // Written only after a complete extract, so a half-unpacked binary can never
    // pass for an installed one — isInstalled() reads this, not the .exe.
    await writeFile(
      join(dest, MARKER),
      JSON.stringify(
        {
          version: asset.version,
          filename: asset.filename,
          sha256: asset.sha256,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    progress.phase = 'done'
    return { version: asset.version, verified: progress.verified, dir: dest }
  } catch (err) {
    progress.phase = 'error'
    progress.error = err.message
    throw err
  } finally {
    // The archive is hundreds of MB and has no use after unpacking — including
    // after a failure, which used to leave it behind.
    if (archive) await rm(archive, { force: true }).catch(() => {})
  }
}

/** The install is only real once this exists; `binary()` alone is not proof. */
export async function isInstalled(dest, bin) {
  try {
    const marker = JSON.parse(await readFile(join(dest, MARKER), 'utf8'))
    // `adopted` marks a build that was already on disk when the marker arrived —
    // it was installed by an earlier version, so it has no recorded hash.
    if (!marker?.sha256 && marker?.adopted !== true) return false
    const s = await stat(join(dest, bin))
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

/**
 * A build installed before this version has no marker, and must not read as
 * missing — it would offer the user a re-download over a working engine. Adopt it
 * once, recording that it was adopted rather than verified.
 */
export async function adoptLegacy(dest, bin) {
  const marker = join(dest, MARKER)
  if (existsSync(marker)) return false
  const target = join(dest, bin)
  if (!existsSync(target)) return false
  try {
    const s = await stat(target)
    if (!s.isFile() || s.size === 0) return false
    await writeFile(
      marker,
      JSON.stringify({ adopted: true, note: 'installed before v1.44, no recorded checksum', adoptedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

export { existsSync }
