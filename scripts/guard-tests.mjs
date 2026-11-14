// Guard tests for the workspace tools.
//
// Run against a manager that already has a workspace configured — ideally in a
// throwaway VM, or with a synthetic tree, never against a real home directory.
// It builds its own fixture, points nothing at anything real, and exercises the
// paths a model could ask for: `..`, absolute paths, a symlink that points out,
// a binary file, a file too large to read.
//
//   node scripts/guard-tests.mjs --root C:/hearth-guard --manager http://127.0.0.1:8090
//
// Exits non-zero if any expectation fails, so it can gate a release.

import { mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { request } from 'node:http'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const ROOT = arg('root', process.platform === 'win32' ? 'C:/hearth-guard' : '/tmp/hearth-guard')
const MANAGER = arg('manager', 'http://127.0.0.1:8090')
// Probing a real system file is only fair in a throwaway guest. On a working
// machine the fixture's own escapes prove the same thing.
const SYSTEM_PATHS = process.argv.includes('--system-paths')

/**
 * The fixture is built by deleting the root first, so a mistyped `--root` is a
 * deleted folder. Refuse anything that does not look disposable: this suite gets
 * run by people who did not write it, and one `--root .` is all it takes.
 */
function assertDisposable(path) {
  const norm = resolve(path)
  const tmp = resolve(tmpdir())
  const inTemp = norm !== tmp && norm.startsWith(tmp + sep)
  if (!inTemp && !/hearth-guard(-test)?$/i.test(norm)) {
    throw new Error(
      `refusing to use ${norm} as a test root — it is deleted before the fixture is built.\n` +
        `  Use a folder named "hearth-guard" (default: ${process.platform === 'win32' ? 'C:/hearth-guard' : '/tmp/hearth-guard'}), or one under ${tmp}.`,
    )
  }
  return norm
}

let failures = 0
let passes = 0

function check(name, ok, detail = '') {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

/**
 * Plain http.request rather than fetch: undici's keep-alive sockets are still
 * open when the process ends, and Node 24 aborts on teardown with
 * "!(handle->flags & UV_HANDLE_CLOSING)" — a crash message on a passing run.
 * One request per socket has no such state.
 */
function call(path, body, method = 'POST') {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body ?? {})
    const req = request(
      MANAGER + path,
      {
        method,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Hearth': '1',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || '{}') })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} })
          }
        })
      },
    )
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }))
    if (payload) req.write(payload)
    req.end()
  })
}

async function buildFixture() {
  const root = join(ROOT, 'root')
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'readme.txt'), 'hello from the workspace\nsecond line\n', 'utf8')
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested content\n', 'utf8')
  await rm(join(ROOT, 'outside.txt'), { force: true })
  await writeFile(join(ROOT, 'outside.txt'), 'this must never be readable\n', 'utf8')
  // 3 MB of text: over the 2 MB cap, so it must be refused rather than read.
  await writeFile(join(root, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8')
  // A NUL byte in the first block is what makes a file "binary" here.
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  // A link inside the workspace that points out of it. Not fatal if the OS
  // refuses to create one (Windows needs developer mode or elevation).
  let symlinked = false
  try {
    await symlink(join(ROOT, 'outside.txt'), join(root, 'escape.txt'))
    symlinked = true
  } catch {
    symlinked = false
  }
  // A *directory* junction out of the root. Junctions need no elevation on
  // Windows, so unlike the symlink above this case always runs — and it is the
  // one that matters: the walk has to not follow it, and a read through it has
  // to be refused after the realpath.
  let junctioned = false
  try {
    await mkdir(join(ROOT, 'outside-dir'), { recursive: true })
    await writeFile(join(ROOT, 'outside-dir', 'secret.txt'), 'junction escape must never be readable\n', 'utf8')
    await symlink(join(ROOT, 'outside-dir'), join(root, 'junction-out'), 'junction')
    junctioned = true
  } catch {
    junctioned = false
  }
  // A unicode filename with spaces: the guard compares resolved paths, and
  // encoding is exactly where a naive check stops matching.
  await writeFile(join(root, 'spaced ünicode file.txt'), 'unicode content here\n', 'utf8')
  return { root, symlinked, junctioned }
}

async function main() {
  assertDisposable(ROOT)
  console.log(`Hearth workspace guard tests\n  manager: ${MANAGER}\n  fixture: ${ROOT}\n`)
  // Where the machine's workspace pointed before this ran, so it can be put back.
  const before = await call('/api/workspace', undefined, 'GET').then((r) => r.body)
  const { root, symlinked, junctioned } = await buildFixture()

  try {
  const opened = await call('/api/workspace', { path: root, enabled: true })
  check('workspace opens on the fixture', opened.status === 200 && opened.body.exists === true, JSON.stringify(opened.body))

  const read = await call('/api/workspace/read', { path: 'readme.txt', lines: 2 })
  check('reads a file inside the root', read.status === 200 && read.body.text.includes('hello from the workspace'))
  check('numbers the lines it returns', read.status === 200 && /^1\| /.test(read.body.text ?? ''))

  const traversals = [
    ['../outside.txt', 'parent traversal'],
    ['sub/../../outside.txt', 'nested traversal'],
    [ROOT.replace(/\/root$/, '') + '/outside.txt', 'absolute path to a sibling'],
  ]
  if (SYSTEM_PATHS) {
    traversals.push([process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd', 'system file'])
  }
  for (const [path, label] of traversals) {
    const r = await call('/api/workspace/read', { path })
    check(`refuses ${label}`, r.status === 400 && /outside the workspace|not a file/.test(r.body.error ?? ''), JSON.stringify(r.body))
  }

  for (const op of ['list', 'search']) {
    const r = await call(`/api/workspace/${op}`, op === 'search' ? { query: 'x', path: '..' } : { path: '..' })
    check(`refuses ${op} outside the root`, r.status === 400 && /outside the workspace/.test(r.body.error ?? ''), JSON.stringify(r.body))
  }

  const bin = await call('/api/workspace/read', { path: 'binary.bin' })
  check('refuses a binary file', bin.status === 400, JSON.stringify(bin.body))

  const huge = await call('/api/workspace/read', { path: 'huge.txt' })
  check('refuses a file over the size cap', huge.status === 400 && /too large/.test(huge.body.error ?? ''), JSON.stringify(huge.body))

  if (symlinked) {
    const esc = await call('/api/workspace/read', { path: 'escape.txt' })
    check('refuses a symlink pointing out of the root', esc.status === 400 && /outside the workspace/.test(esc.body.error ?? ''), JSON.stringify(esc.body))
  } else {
    console.log('  SKIP  symlink escape (this OS would not create the link)')
  }

  if (junctioned) {
    // All three tools, because each resolves the path a different way: read
    // realpaths the leaf, list and search realpath the directory.
    const viaJunction = await call('/api/workspace/read', { path: 'junction-out/secret.txt' })
    check(
      'refuses a read through a directory junction out of the root',
      viaJunction.status === 400 && /outside the workspace/.test(viaJunction.body.error ?? ''),
      JSON.stringify(viaJunction.body),
    )
    const listJunction = await call('/api/workspace/list', { path: 'junction-out' })
    check(
      'refuses a listing through a directory junction out of the root',
      listJunction.status === 400 && /outside the workspace/.test(listJunction.body.error ?? ''),
      JSON.stringify(listJunction.body),
    )
    const searchJunction = await call('/api/workspace/search', { query: 'junction escape', path: 'junction-out' })
    check(
      'refuses a search through a directory junction out of the root',
      searchJunction.status === 400 && /outside the workspace/.test(searchJunction.body.error ?? ''),
      JSON.stringify(searchJunction.body),
    )
    // The root listing may show the name — that is not a leak — but a search
    // from the root must not reach through it either.
    const rootSearch = await call('/api/workspace/search', { query: 'junction escape', path: '.' })
    check(
      'does not see through a junction when searched from the root',
      rootSearch.status === 200 && (rootSearch.body.hits?.length ?? 0) === 0,
      JSON.stringify(rootSearch.body).slice(0, 200),
    )
  } else {
    console.log('  SKIP  junction escape (could not create a junction)')
  }

  const uni = await call('/api/workspace/read', { path: 'spaced ünicode file.txt' })
  check(
    'reads a unicode filename containing spaces',
    uni.status === 200 && (uni.body.text ?? '').includes('unicode content here'),
    JSON.stringify(uni.body).slice(0, 200),
  )
  const uniSearch = await call('/api/workspace/search', { query: 'unicode content here' })
  check(
    'finds text in a unicode-named file',
    uniSearch.status === 200 && (uniSearch.body.hits?.length ?? 0) > 0,
    JSON.stringify(uniSearch.body).slice(0, 200),
  )

  const search = await call('/api/workspace/search', { query: 'nested', limit: 5 })
  check('finds text inside the root', search.status === 200 && (search.body.hits?.length ?? 0) > 0)

  const off = await call('/api/workspace', { enabled: false })
  check('closes the workspace', off.status === 200 && off.body.enabled === false)
  const blocked = await call('/api/workspace/search', { query: 'nested' })
  check('refuses every tool while closed', blocked.status === 403, JSON.stringify(blocked.body))

  } finally {
    // In a finally, not at the end: an assertion that throws must not leave
    // someone's workspace pointing at a fixture folder.
    if (before?.path) await call('/api/workspace', { path: before.path, enabled: Boolean(before.enabled) })
    else await call('/api/workspace', { path: '', enabled: false })
  }

  console.log(`\n  ${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('guard tests could not run:', err.message)
  process.exitCode = 2
})
