// Reading a folder, for the model.
//
// This is retrieval without an index: the model asks for a listing, a search or
// a file, and the manager answers from disk. For code and notes it beats
// embeddings most of the time — a grep for an identifier is exact, and the model
// sees the same file the user would open.
//
// It is also the first feature that reads the user's files, so the guard matters
// more than the search: every path is resolved and checked against the workspace
// root, symlinks are resolved before the check, and nothing outside the root is
// reachable by `..`, by an absolute path, or by a link that points out.

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, relative, sep, isAbsolute, extname } from 'node:path'

/** Directories that are never worth walking. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.vite',
  '.venv', 'venv', '__pycache__', '.cache', '.idea', '.vs', 'target', 'obj',
])

/** Files that are never worth reading. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.gguf', '.safetensors', '.onnx', '.mp3', '.mp4', '.wav', '.webm', '.woff',
  '.woff2', '.ttf', '.otf', '.pyc', '.class', '.jar', '.db', '.sqlite',
])

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_WALK_FILES = 5000

export class WorkspaceError extends Error {}

function under(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The workspace root, canonicalised. A path that is not a directory, or does not
 * exist, is refused rather than silently emptied.
 */
export async function resolveRoot(path) {
  if (!path || typeof path !== 'string') throw new WorkspaceError('no workspace folder is set')
  const abs = resolve(path)
  let real
  try {
    real = await realpath(abs)
  } catch {
    throw new WorkspaceError(`no such folder: ${path}`)
  }
  const info = await stat(real)
  if (!info.isDirectory()) throw new WorkspaceError(`not a folder: ${path}`)
  return real
}

/**
 * Resolve a path the model supplied, and refuse it if it escapes the root.
 * `realpath` is what makes this a check rather than a hope: a symlink inside the
 * workspace that points at C:\Users is caught by comparing the *resolved* paths.
 */
export async function safePath(root, rel) {
  const target = resolve(root, rel ?? '.')
  if (!under(root, target)) throw new WorkspaceError(`outside the workspace: ${rel}`)
  let real = target
  try {
    real = await realpath(target)
  } catch {
    // A file that does not exist cannot be read; let the caller report it.
    return target
  }
  if (!under(root, real)) throw new WorkspaceError(`outside the workspace: ${rel}`)
  return real
}

function readable(name) {
  const ext = extname(name).toLowerCase()
  return !SKIP_EXT.has(ext)
}

async function looksTextual(path) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return false
    const buf = await readFile(path)
    return !buf.subarray(0, 8192).includes(0)
  } catch {
    return false
  }
}

/** Walk, breadth-first, skipping the directories nobody wants in a listing. */
async function walk(root, start, limit) {
  const out = []
  const queue = [start]
  let seen = 0
  while (queue.length && out.length < limit && seen < MAX_WALK_FILES) {
    const dir = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen++
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(full)
      } else if (entry.isFile()) {
        if (!readable(entry.name)) continue
        out.push(full)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/** A directory listing: relative paths, directories with a trailing slash. */
export async function listTree(root, rel = '.', opts = {}) {
  const dir = await safePath(root, rel)
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw new WorkspaceError(`not a folder: ${rel}`)

  const depth = Math.min(Math.max(Number(opts.depth) || 2, 1), 4)
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 800)
  const lines = []
  let truncated = false

  async function walkDir(current, level) {
    if (level > depth || lines.length >= limit) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (lines.length >= limit) {
        truncated = true
        return
      }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      if (entry.isFile() && !readable(entry.name)) continue
      const full = join(current, entry.name)
      if (!under(root, full)) continue
      const relPath = relative(root, full).split(sep).join('/')
      lines.push(entry.isDirectory() ? `${relPath}/` : relPath)
      if (entry.isDirectory()) await walkDir(full, level + 1)
    }
  }

  await walkDir(dir, 1)
  return { path: relative(root, dir).split(sep).join('/') || '.', entries: lines, truncated }
}

/** Search file contents. Literal by default; `regex` opts into a pattern. */
export async function searchFiles(root, query, opts = {}) {
  const q = String(query ?? '')
  if (!q.trim()) throw new WorkspaceError('no search text was given')
  const start = await safePath(root, opts.path ?? '.')
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200)

  let matcher
  if (opts.regex) {
    try {
      matcher = new RegExp(q, opts.ignoreCase === false ? 'g' : 'gi')
    } catch (err) {
      throw new WorkspaceError(`bad pattern: ${err.message}`)
    }
  } else {
    const needle = opts.ignoreCase === false ? q : q.toLowerCase()
    matcher = {
      test: (line) => (opts.ignoreCase === false ? line : line.toLowerCase()).includes(needle),
    }
  }

  const files = await walk(root, start, 900)
  const hits = []
  let scanned = 0
  for (const file of files) {
    if (hits.length >= limit) break
    if (!(await looksTextual(file))) continue
    scanned++
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 400) continue
      if (!matcher.test(line)) continue
      hits.push({
        file: relative(root, file).split(sep).join('/'),
        line: i + 1,
        text: line.trim().slice(0, 240),
      })
      if (hits.length >= limit) break
    }
  }

  return { query: q, regex: Boolean(opts.regex), scanned, hits, truncated: hits.length >= limit }
}

/** Read a file, by line range, capped. */
export async function readWorkspaceFile(root, rel, opts = {}) {
  const file = await safePath(root, rel)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new WorkspaceError(`not a file: ${rel}`)
  if (info.size > MAX_FILE_BYTES) throw new WorkspaceError(`file is too large to read (${Math.round(info.size / 1024)} KB)`)
  if (!(await looksTextual(file))) throw new WorkspaceError(`${rel} is not a text file`)

  const text = await readFile(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const start = Math.max(Number(opts.start) || 1, 1)
  const count = Math.min(Math.max(Number(opts.lines) || 200, 1), 800)
  const slice = lines.slice(start - 1, start - 1 + count)

  let body = slice.map((l, i) => `${start + i}| ${l}`).join('\n')
  const LIMIT = 20000
  const truncated = body.length > LIMIT
  if (truncated) body = `${body.slice(0, LIMIT)}\n[…truncated…]`

  return {
    path: relative(root, file).split(sep).join('/'),
    start,
    end: start + slice.length - 1,
    total: lines.length,
    text: body,
    truncated: truncated || start + slice.length - 1 < lines.length,
  }
}

/** A quick sanity report for the settings panel. */
export async function describe(root) {
  const listing = await listTree(root, '.', { depth: 1, limit: 40 })
  return { path: root, top: listing.entries }
}
