// Install and run a SearXNG instance, so web search needs no key and no account.
//
// SearXNG is a Python (Flask) application, and upstream supports Linux only. It
// does run on Windows — this module exists because it was proven to — with two
// accommodations, both discovered by trying it:
//
//   1. The source tarball contains symlinks (utils/templates/etc/apache2) which
//      Windows tar cannot create without privileges, so only the directories
//      that matter are extracted.
//   2. searx/valkeydb.py imports `pwd`, which Windows does not have. A four-line
//      shim goes into the venv's site-packages rather than into the source: a
//      future upgrade replaces the source, and must not silently lose the fix.
//
// The install is pinned to a commit SHA. There is no checksum to verify against
// (GitHub serves the tarball, not a signed artefact), so the integrity story is
// HTTPS plus a pin, and the pin is visible in the settings the app writes.

import { createWriteStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)

/** Pinned upstream commit. Bump deliberately, then re-test the whole flow. */
export const SOURCE = {
  version: '2026.11.12',
  sha: 'de722ab1b',
  url: 'https://codeload.github.com/searxng/searxng/tar.gz/de722ab1b',
}

const PORT = Number(process.env.HEARTH_SEARXNG_PORT ?? 8888)
const HOST = '127.0.0.1'

/**
 * Windows' own bsdtar, by absolute path.
 *
 * `tar` on PATH is whatever the parent shell had — under git-bash that is GNU
 * tar, which reads `C:\...` as `host:path` and fails with "Cannot connect to C".
 * The manager is often started from such a shell, so the path is resolved rather
 * than assumed.
 */
const TAR =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
    : 'tar'

/** Directories we do not need, and which carry the symlinks that break tar. */
const EXCLUDES = ['*/utils/*', '*/container/*', '*/docs/*', '*/tests/*', '*/client/*', '*/man/*']

export const progress = {
  phase: 'idle', // idle | resolving | downloading | extracting | venv | deps | configuring | done | error
  got: 0,
  total: 0,
  step: null,
  error: null,
}

const log = []
function push(line) {
  for (const part of String(line).split('\n')) {
    if (!part.trim()) continue
    log.push(part.trim())
  }
  while (log.length > 200) log.shift()
}

function reset() {
  progress.phase = 'idle'
  progress.got = 0
  progress.total = 0
  progress.step = null
  progress.error = null
}

let child = null
let startedAt = null

/**
 * A pidfile, because the manager can be restarted (or force-killed) while
 * SearXNG is up. Without it the new manager has no handle on the process and
 * Remove fails with EBUSY: Windows will not delete files a live Python is
 * holding. The file is the memory of a process the manager no longer owns.
 */
function readPid(dataDir) {
  try {
    const pid = Number(readFileSync(paths(dataDir).pidfile, 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function writePid(dataDir, pid) {
  try {
    writeFileSync(paths(dataDir).pidfile, String(pid), 'utf8')
  } catch {
    // A pidfile that cannot be written is not worth failing a start over.
  }
}

function clearPid(dataDir) {
  try {
    rmSync(paths(dataDir).pidfile, { force: true })
  } catch {
    // nothing to clear
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function runningPid(dataDir) {
  // Only ever a process this manager spawned. The pidfile stays as bookkeeping
  // for the UI, but nothing is signalled from it: a pid read off disk can be
  // stale, Windows reuses pids, and killing a stranger's process is a worse
  // failure than an orphaned server.
  return child?.pid ?? null
}

export function paths(dataDir) {
  const root = join(dataDir, 'searxng')
  return {
    root,
    app: join(root, 'app'),
    venv: join(root, 'venv'),
    settings: join(root, 'settings.yml'),
    marker: join(root, 'installed.json'),
    pidfile: join(root, 'pid'),
    log: join(root, 'searxng.log'),
  }
}

/** A Python that can build a venv. 3.11 or newer; nothing else is guaranteed. */
export async function findPython() {
  const candidates =
    process.platform === 'win32'
      ? [
          ['py', ['-3.12']],
          ['py', ['-3.11']],
          ['py', ['-3.13']],
          ['python', []],
        ]
      : [['python3', []], ['python', []]]

  for (const [bin, args] of candidates) {
    try {
      const { stdout } = await run(bin, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2]); print(sys.executable)'], { windowsHide: true })
      const [version, path] = stdout.trim().split(/\r?\n/)
      const [major, minor] = version.split('.').map(Number)
      if (major === 3 && minor >= 11) return { version, path, bin, args }
    } catch {
      // Not this one.
    }
  }
  return null
}

export async function isInstalled(dataDir) {
  const p = paths(dataDir)
  return existsSync(p.marker) && existsSync(join(p.venv, 'Scripts', 'python.exe'))
}

async function readMarker(dataDir) {
  try {
    return JSON.parse(await readFile(paths(dataDir).marker, 'utf8'))
  } catch {
    return null
  }
}

async function download(url, dest, onBytes) {
  const res = await fetch(url, { headers: { 'User-Agent': 'hearth' } })
  if (!res.ok) throw new Error(`download answered ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  progress.total = total

  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest)
    const reader = res.body.getReader()
    let got = 0
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) {
          out.end(() => resolve())
          return
        }
        got += value.byteLength
        progress.got = got
        onBytes?.(got)
        out.write(Buffer.from(value), (err) => (err ? reject(err) : pump()))
      })
    pump().catch(reject)
  })
}

/** Write the settings SearXNG needs: JSON on, no limiter, bound to loopback. */
async function writeSettings(dataDir, python) {
  const p = paths(dataDir)
  const script = join(p.root, 'make-settings.py')
  await writeFile(
    script,
    [
      'import secrets, sys, yaml',
      'src, dest = sys.argv[1], sys.argv[2]',
      'cfg = yaml.safe_load(open(src, encoding="utf-8"))',
      'cfg["use_default_settings"] = True',
      's = cfg.setdefault("server", {})',
      's["port"] = int(sys.argv[3])',
      's["bind_address"] = "127.0.0.1"',
      's["secret_key"] = secrets.token_hex(32)',
      's["limiter"] = False',
      's["public_instance"] = False',
      's["image_proxy"] = False',
      'g = cfg.setdefault("general", {})',
      'g["contact_url"] = "http://127.0.0.1:%d/" % int(sys.argv[3])',
      'q = cfg.setdefault("search", {})',
      'fmts = set(q.get("formats") or ["html"]); fmts.add("json")',
      'q["formats"] = sorted(fmts)',
      'o = cfg.setdefault("outgoing", {})',
      'o["request_timeout"] = 4.0',
      'o["max_request_timeout"] = 8.0',
      'yaml.safe_dump(cfg, open(dest, "w", encoding="utf-8"), sort_keys=False, allow_unicode=True)',
    ].join('\n'),
    'utf8',
  )
  await run(python, [script, join(p.app, 'searx', 'settings.yml'), p.settings, String(PORT)], { windowsHide: true })
  await rm(script, { force: true })
}

/** `import pwd` is Unix-only; SearXNG uses it to name one valkey key. */
async function writePwdShim(python, venv) {
  const { stdout } = await run(python, ['-c', 'import site; print(site.getsitepackages()[0])'], { windowsHide: true })
  const site = stdout.trim().split(/\r?\n/).pop()
  await writeFile(
    join(site, 'pwd.py'),
    [
      '"""Hearth: Windows shim for the Unix-only pwd module SearXNG imports."""',
      'import os',
      '',
      'class struct_passwd(tuple):',
      '    @property',
      '    def pw_name(self): return self[0]',
      '    @property',
      '    def pw_uid(self): return self[2]',
      '    @property',
      '    def pw_gid(self): return self[3]',
      '',
      'def getpwuid(uid=None):',
      "    name = os.environ.get('USERNAME') or os.environ.get('USER') or 'hearth'",
      "    return struct_passwd((name, 'x', 0, 0, '', os.environ.get('TEMP', ''), ''))",
      '',
      'def getpwnam(name):',
      '    return getpwuid(0)',
      '',
      'def getpwall():',
      '    return [getpwuid(0)]',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Download, unpack, build a venv, install the pinned requirements, and write a
 * settings file. Throws with a message worth showing; the caller reports it.
 */
export async function install(dataDir) {
  if (progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error') {
    throw new Error('an install is already running')
  }
  reset()
  const p = paths(dataDir)

  try {
    progress.phase = 'resolving'
    progress.step = 'finding Python'
    const python = await findPython()
    if (!python) throw new Error('needs Python 3.11 or newer — none was found on PATH')

    // Anything left from a previous attempt goes first — a stale folder is how
    // an install ends up with two venvs and one mystery.
    stop(dataDir)
    await new Promise((r) => setTimeout(r, 400))
    await rmRetrying(p.root)
    await mkdir(p.root, { recursive: true })
    await mkdir(p.app, { recursive: true })

    progress.phase = 'downloading'
    progress.step = `downloading SearXNG ${SOURCE.version}`
    push(`[searxng] source ${SOURCE.url}`)
    const tarball = join(p.root, 'source.tar.gz')
    await download(SOURCE.url, tarball, (got) => {
      progress.step = `downloading — ${Math.round(got / 1048576)} MB`
    })

    progress.phase = 'extracting'
    progress.step = 'unpacking'
    if (!existsSync(TAR)) throw new Error(`no tar to unpack with (looked for ${TAR})`)
    const args = ['-xzf', tarball, '-C', p.app, '--strip-components=1']
    for (const x of EXCLUDES) args.push(`--exclude=${x}`)
    await run(TAR, args, { windowsHide: true })
    await rm(tarball, { force: true })
    if (!existsSync(join(p.app, 'requirements.txt'))) throw new Error('the archive did not contain requirements.txt')

    progress.phase = 'venv'
    progress.step = `creating a virtualenv with Python ${python.version}`
    await run(python.path, ['-m', 'venv', p.venv], { windowsHide: true })
    const venvPython = join(p.venv, 'Scripts', 'python.exe')

    progress.phase = 'deps'
    progress.step = 'installing dependencies (a minute or two)'
    push('[searxng] pip install -r requirements.txt')
    const { stdout, stderr } = await run(
      venvPython,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', join(p.app, 'requirements.txt')],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    )
    for (const line of `${stdout}\n${stderr}`.split('\n')) if (line.trim()) push(`[pip] ${line}`)

    progress.phase = 'configuring'
    progress.step = 'writing settings'
    await writeSettings(dataDir, venvPython)
    await writePwdShim(venvPython, p.venv)

    await writeFile(
      p.marker,
      JSON.stringify(
        { version: SOURCE.version, sha: SOURCE.sha, installedAt: new Date().toISOString(), port: PORT, python: python.version },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    progress.phase = 'done'
    progress.step = null
    push(`[searxng] installed ${SOURCE.version} (${SOURCE.sha})`)
    return await readMarker(dataDir)
  } catch (err) {
    progress.phase = 'error'
    progress.error = err.message
    progress.step = null
    push(`[searxng] install failed: ${err.message}`)
    // A half-built venv is worse than none: it looks installed and is not.
    await rm(p.root, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export function status(dataDir) {
  const p = paths(dataDir)
  const pid = runningPid(dataDir)
  // A pid on disk that is not one of ours. Reported so the UI can say why the
  // port is busy; never signalled.
  const filePid = readPid(dataDir)
  const unattributed = !pid && filePid && alive(filePid) ? filePid : null
  return {
    installed: existsSync(p.marker),
    running: Boolean(pid),
    pid,
    unattributed,
    startedAt,
    url: `http://${HOST}:${PORT}`,
    port: PORT,
    source: SOURCE,
    progress: { ...progress },
    log: log.slice(-40),
    root: p.root,
  }
}

async function healthy(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Start the installed instance and wait until it answers. */
export async function start(dataDir) {
  if (runningPid(dataDir)) return status(dataDir)
  if (!(await isInstalled(dataDir))) throw new Error('SearXNG is not installed')

  // An instance from a previous manager may still be answering — we will not
  // signal a process we did not spawn, so adopt the port instead of fighting it
  // for the bind and failing with a confusing "did not answer in 30 seconds".
  if (await healthy(1500)) {
    push(`[searxng] something is already answering on ${HOST}:${PORT} — not starting a second one`)
    return { ...status(dataDir), running: true, adopted: true }
  }
  clearPid(dataDir)

  const p = paths(dataDir)
  const python = join(p.venv, 'Scripts', 'python.exe')
  push('[searxng] starting')
  child = spawn(python, ['-m', 'searx.webapp'], {
    cwd: p.app,
    windowsHide: true,
    env: { ...process.env, SEARXNG_SETTINGS_PATH: p.settings, PYTHONPATH: p.app },
  })
  startedAt = Date.now()
  writePid(dataDir, child.pid)

  child.stdout.on('data', (d) => push(d.toString()))
  child.stderr.on('data', (d) => push(d.toString()))
  child.on('error', (err) => {
    push(`[searxng] spawn error: ${err.message}`)
    child = null
  })
  child.on('exit', (code) => {
    push(`[searxng] exited with ${code}`)
    child = null
    startedAt = null
    clearPid(dataDir)
  })

  if (!(await healthy())) {
    stop()
    throw new Error('SearXNG did not answer within 30 seconds')
  }
  push(`[searxng] ready on ${HOST}:${PORT}`)
  return status(dataDir)
}

export function stop(dataDir) {
  const pid = runningPid(dataDir)
  if (!pid) return false
  push(`[searxng] stopping pid ${pid}`)
  try {
    process.kill(pid)
  } catch {
    // Already gone between the check and the signal.
  }
  child = null
  startedAt = null
  clearPid(dataDir)
  return true
}

/** Windows keeps file handles for a moment after a process dies. */
async function rmRetrying(dir, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

/** Remove the install and everything it wrote. */
export async function uninstall(dataDir) {
  stop(dataDir)
  // Give the process a moment to let go of its files before deleting them.
  await new Promise((r) => setTimeout(r, 600))
  const p = paths(dataDir)

  // In order, and the marker last: while it exists the UI keeps saying
  // "installed", which is true. Deleting the marker first is how you get a
  // 24 MB half-deleted folder that claims never to have existed.
  for (const target of [p.venv, p.app, p.settings, p.pidfile, p.log]) {
    await rmRetrying(target)
  }
  await rmRetrying(p.marker)
  await rmRetrying(p.root)
  push('[searxng] removed')
  return { removed: true }
}
