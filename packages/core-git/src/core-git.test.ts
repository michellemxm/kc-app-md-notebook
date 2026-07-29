import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneVault, status, autoCommit, sync } from './index.js'

const BRANCH = 'trunk' // non-protected branch for fixture pushes

/** Run system git in `cwd` (allowed for fixture setup only). */
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let root: string
let bare: string
let url: string

/**
 * Build a bare remote (via `git clone --bare`, so no push to a protected branch)
 * seeded with note.md + nested/deep.md on the `trunk` branch.
 */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-git-'))
  const seed = path.join(root, 'seed')
  fs.mkdirSync(seed)
  gitIn(seed, 'init', '-b', BRANCH)
  gitIn(seed, 'config', 'user.email', 'fixture@test.local')
  gitIn(seed, 'config', 'user.name', 'Fixture')
  fs.writeFileSync(path.join(seed, 'note.md'), 'base\n')
  fs.mkdirSync(path.join(seed, 'nested'))
  fs.writeFileSync(path.join(seed, 'nested', 'deep.md'), 'deep\n')
  gitIn(seed, 'add', '-A')
  gitIn(seed, 'commit', '-m', 'seed')

  bare = path.join(root, 'remote.git')
  gitIn(root, 'clone', '--bare', seed, bare)
  url = `file://${bare}`
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Push a divergent edit to the remote via a separate system clone. */
function pushRemoteEdit(file: string, content: string): void {
  const other = path.join(root, 'other')
  gitIn(root, 'clone', bare, other)
  gitIn(other, 'config', 'user.email', 'remote@test.local')
  gitIn(other, 'config', 'user.name', 'Remote')
  fs.writeFileSync(path.join(other, file), content)
  gitIn(other, 'add', '-A')
  gitIn(other, 'commit', '-m', 'remote change')
  gitIn(other, 'push', 'origin', BRANCH)
}

describe('cloneVault', () => {
  it('shallow-clones from a file:// fixture and returns a Vault descriptor', async () => {
    const dir = path.join(root, 'clone')
    const vault = await cloneVault({ url, dir, branch: BRANCH, subfolder: 'nested' })

    expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toBe('base\n')
    expect(fs.readFileSync(path.join(dir, 'nested', 'deep.md'), 'utf8')).toBe('deep\n')
    expect(vault.branch).toBe(BRANCH)
    expect(vault.localPath).toBe(dir)
    expect(vault.subfolder).toBe('nested')
    expect(vault.repo).toContain('remote')
    expect(vault.readOnly).toBe(false)
    expect(vault.id).toBeTruthy()
  })
})

describe('status', () => {
  it('detects added, modified, and deleted files vs HEAD', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })

    fs.writeFileSync(path.join(dir, 'added.md'), 'new\n')
    fs.writeFileSync(path.join(dir, 'note.md'), 'changed\n')
    fs.rmSync(path.join(dir, 'nested', 'deep.md'))

    const changes = await status(dir)
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.kind]))
    expect(byPath['added.md']).toBe('added')
    expect(byPath['note.md']).toBe('modified')
    expect(byPath['nested/deep.md']).toBe('deleted')
  })

  it('scopes results to a subfolder when requested', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })
    fs.writeFileSync(path.join(dir, 'note.md'), 'changed\n')
    fs.writeFileSync(path.join(dir, 'nested', 'deep.md'), 'changed\n')

    const scoped = await status(dir, { subfolder: 'nested' })
    expect(scoped.map((c) => c.path)).toEqual(['nested/deep.md'])
  })
})

describe('autoCommit', () => {
  it('stages and commits, generating "Update <filename>" for a single file', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })
    fs.writeFileSync(path.join(dir, 'note.md'), 'edited\n')

    const result = await autoCommit(dir)
    expect(result.oid).toBeTruthy()
    expect(result.message).toBe('Update note.md')
    expect(result.committed).toHaveLength(1)
    expect(await status(dir)).toHaveLength(0)
  })

  it('returns a null oid when there is nothing to commit', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })
    const result = await autoCommit(dir)
    expect(result.oid).toBeNull()
    expect(result.committed).toHaveLength(0)
  })
})

describe('sync', () => {
  it('pushes local-only commits to the remote (clean fast-forward)', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })
    fs.writeFileSync(path.join(dir, 'note.md'), 'local only\n')
    await autoCommit(dir)

    const res = await sync(dir, { branch: BRANCH })
    expect(res.conflicts).toHaveLength(0)
    expect(res.pushed).toBe(true)

    const verify = path.join(root, 'verify')
    gitIn(root, 'clone', bare, verify)
    expect(fs.readFileSync(path.join(verify, 'note.md'), 'utf8')).toBe('local only\n')
  })

  it('returns conflicts with BOTH versions and leaves the working tree unclobbered', async () => {
    const dir = path.join(root, 'clone')
    await cloneVault({ url, dir, branch: BRANCH })

    // Local edit (left uncommitted so sync's own auto-commit path is exercised).
    fs.writeFileSync(path.join(dir, 'note.md'), 'LOCAL EDIT\n')
    // Divergent remote edit to the same file.
    pushRemoteEdit('note.md', 'REMOTE EDIT\n')

    const res = await sync(dir, { branch: BRANCH })

    expect(res.pushed).toBe(false)
    expect(res.pulled).toBe(false)
    expect(res.committed.map((c) => c.path)).toContain('note.md')
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0].path).toBe('note.md')
    expect(res.conflicts[0].local).toBe('LOCAL EDIT\n')
    expect(res.conflicts[0].remote).toBe('REMOTE EDIT\n')

    // Working tree must still hold the LOCAL content — never overwritten.
    expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toBe('LOCAL EDIT\n')
  })
})
