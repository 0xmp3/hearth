// The workspace path guard, as a unit.
//
// `scripts/guard-tests.mjs` proves the guard end to end against a live manager,
// in the VM, including symlinks and junctions — that stays the acceptance test.
// This is the cheap half: the resolve-and-compare decision, exercised directly,
// so a change to it fails in a second rather than in a browser suite.
//
// Everything here is built inside a disposable temp directory. The fixture never
// points at the user's repo, their documents, or any system path: a guard test
// that accidentally succeeds is a real file read on a real machine.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRoot, safePath } from '../../../server/workspace/files.mjs'

let base = ''
let root = ''

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'hearth-pathguard-'))
  root = join(base, 'workspace')
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'inside.txt'), 'hello')
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested')
  await writeFile(join(base, 'outside.txt'), 'secret')
})

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true })
})

describe('safePath', () => {
  it('resolves a file inside the root', async () => {
    await expect(safePath(root, 'inside.txt')).resolves.toBe(join(root, 'inside.txt'))
  })

  it('resolves a nested file', async () => {
    await expect(safePath(root, 'sub/nested.txt')).resolves.toBe(join(root, 'sub', 'nested.txt'))
  })

  it('allows a traversal that stays inside the root', async () => {
    await expect(safePath(root, 'sub/../inside.txt')).resolves.toBe(join(root, 'inside.txt'))
  })

  it('refuses a relative path that climbs out', async () => {
    await expect(safePath(root, '../outside.txt')).rejects.toThrow(/outside the workspace/)
  })

  it('refuses a deep climb out', async () => {
    await expect(safePath(root, 'sub/../../outside.txt')).rejects.toThrow(/outside the workspace/)
  })

  it('refuses an absolute path to a sibling', async () => {
    await expect(safePath(root, join(base, 'outside.txt'))).rejects.toThrow(/outside the workspace/)
  })

  it('returns the target for something that does not exist, and lets the caller report it', async () => {
    await expect(safePath(root, 'missing.txt')).resolves.toBe(join(root, 'missing.txt'))
  })

  it('refuses a link that points out of the root, where the platform allows one', async () => {
    const link = join(root, 'link.txt')
    try {
      await symlink(join(base, 'outside.txt'), link, 'file')
    } catch {
      // Windows without developer mode cannot create a symlink. The junction and
      // symlink cases are covered by guard-tests.mjs in the VM; skipping here is
      // not a pass, so the reason is printed.
      console.warn('symlink not permitted on this machine — covered by guard-tests.mjs')
      return
    }
    await expect(safePath(root, 'link.txt')).rejects.toThrow(/outside the workspace/)
  })
})

describe('resolveRoot', () => {
  it('returns the canonical root', async () => {
    await expect(resolveRoot(root)).resolves.toBe(root)
  })

  it('refuses a file', async () => {
    await expect(resolveRoot(join(root, 'inside.txt'))).rejects.toThrow(/not a folder/)
  })

  it('refuses a folder that does not exist', async () => {
    await expect(resolveRoot(join(base, 'nope'))).rejects.toThrow(/no such folder/)
  })

  it('refuses an empty value rather than emptying the listing', async () => {
    await expect(resolveRoot('')).rejects.toThrow(/no workspace folder/)
  })
})
