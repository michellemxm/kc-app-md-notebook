import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PORT = 19137
const BASE = `http://127.0.0.1:${PORT}`
let proc
let fixtureUrl
let localCheckout
let plainDir

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  // Fixture: a bare repo with two notes, served over file:// (core-git local transport).
  const base = mkdtempSync(join(tmpdir(), 'mdnb-'))
  const work = join(base, 'work')
  mkdirSync(work)
  git(base, 'init', '--bare', '-b', 'trunk', 'origin.git')
  git(work, 'init', '-b', 'trunk')
  git(work, 'config', 'user.email', 't@t')
  git(work, 'config', 'user.name', 'T')
  writeFileSync(join(work, 'Home.md'), '# Home\nlinks to [[Ideas]] here\n#start\n')
  mkdirSync(join(work, 'sub'))
  writeFileSync(join(work, 'sub', 'Ideas.md'), '---\ntitle: Ideas\n---\nbig plans about rockets\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'seed')
  git(work, 'remote', 'add', 'origin', join(base, 'origin.git'))
  git(work, 'push', 'origin', 'trunk')
  fixtureUrl = 'file://' + join(base, 'origin.git')

  // A checkout the "user" already has on disk — the attach target.
  git(base, 'clone', '--branch', 'trunk', join(base, 'origin.git'), 'my-notes')
  localCheckout = join(base, 'my-notes')
  plainDir = join(base, 'plain')
  mkdirSync(plainDir)

  // Server with isolated state home.
  proc = spawn(process.execPath, [join(import.meta.dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), MD_NOTEBOOK_HOME: join(base, 'home') },
    stdio: 'pipe',
  })
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/health'); return } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  throw new Error('server did not start')
}, 20000)

afterAll(() => { proc?.kill() })

describe('md-notebook backend', () => {
  it('health responds', async () => {
    expect((await api('GET', '/health')).body.ok).toBe(true)
  })

  it('connects a vault by cloning the fixture repo', async () => {
    const { status, body } = await api('POST', '/api/vaults', { url: fixtureUrl, branch: 'trunk', name: 'Fixture' })
    expect(status).toBe(200)
    expect(body.vault.name).toBe('Fixture')
  })

  it('lists notes with titles and sync status', async () => {
    const { body } = await api('GET', '/api/notes')
    const paths = body.notes.map((n) => n.path).sort()
    expect(paths).toEqual(['Home.md', 'sub/Ideas.md'])
    expect(body.notes.every((n) => n.syncStatus === 'synced')).toBe(true)
    expect(body.notes.find((n) => n.path === 'sub/Ideas.md').title).toBe('Ideas')
  })

  it('reads a note with metadata and backlinks', async () => {
    const { body } = await api('GET', '/api/note?path=sub%2FIdeas.md')
    expect(body.content).toContain('rockets')
    expect(body.backlinks).toEqual([
      { sourcePath: 'Home.md', line: 2, context: 'links to [[Ideas]] here' },
    ])
  })

  it('saves a note and marks it pending', async () => {
    const put = await api('PUT', '/api/note', { path: 'Home.md', content: '# Home\nedited [[Ideas]]\n' })
    expect(put.status).toBe(200)
    const { body } = await api('GET', '/api/notes')
    expect(body.notes.find((n) => n.path === 'Home.md').syncStatus).toBe('pending')
  })

  it('searches by content', async () => {
    const { body } = await api('GET', '/api/search?q=rockets')
    expect(body.results[0].path).toBe('sub/Ideas.md')
  })

  it('sync commits and pushes; note returns to synced', async () => {
    const { body } = await api('POST', '/api/sync')
    expect(body.result.pushed).toBe(true)
    expect(body.result.conflicts).toEqual([])
    const notes = await api('GET', '/api/notes')
    expect(notes.body.notes.find((n) => n.path === 'Home.md').syncStatus).toBe('synced')
  })

  it('creates and deletes a note', async () => {
    await api('PUT', '/api/note', { path: 'new/Draft.md', content: 'draft #wip' })
    let notes = (await api('GET', '/api/notes')).body.notes
    expect(notes.some((n) => n.path === 'new/Draft.md')).toBe(true)
    await api('DELETE', '/api/note?path=new%2FDraft.md')
    notes = (await api('GET', '/api/notes')).body.notes
    expect(notes.some((n) => n.path === 'new/Draft.md')).toBe(false)
  })

  it('rejects path traversal', async () => {
    const { status } = await api('GET', '/api/note?path=..%2F..%2Fetc%2Fpasswd')
    expect(status).toBe(500)
  })

  // ---- attaching an existing local checkout (no second clone) ----

  let attached
  it('attaches an existing local checkout in place and lists its notes', async () => {
    const { status, body } = await api('POST', '/api/vaults/attach', { path: localCheckout, name: 'Mine' })
    expect(status).toBe(200)
    expect(body.vault.localPath).toBe(localCheckout)
    expect(body.vault.branch).toBe('trunk')
    attached = body.vault.id

    const list = await api('GET', `/api/notes?vault=${attached}`)
    expect(list.body.notes.map((n) => n.path).sort()).toEqual(['Home.md', 'sub/Ideas.md'])
  })

  it('refuses a non-git folder and a folder already attached', async () => {
    const plain = await api('POST', '/api/vaults/attach', { path: plainDir })
    expect(plain.status).toBe(400)
    expect(plain.body.code).toBe('ENOGIT')

    const dupe = await api('POST', '/api/vaults/attach', { path: localCheckout })
    expect(dupe.status).toBe(409)
  })

  it('blocks a save that would clobber an external edit, and allows it once refreshed', async () => {
    const read = await api('GET', `/api/note?path=Home.md&vault=${attached}`)
    expect(typeof read.body.mtime).toBe('number')

    // Someone edits the file outside the app (Obsidian, git pull, editor).
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(localCheckout, 'Home.md'), '# Home\nEDITED OUTSIDE THE APP\n')

    const stale = await api('PUT', `/api/note?vault=${attached}`, {
      path: 'Home.md', content: '# Home\napp version\n', baseMtime: read.body.mtime,
    })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('ESTALE')
    expect(stale.body.disk).toContain('EDITED OUTSIDE THE APP')

    // The external edit survived — nothing was overwritten.
    const after = await api('GET', `/api/note?path=Home.md&vault=${attached}`)
    expect(after.body.content).toContain('EDITED OUTSIDE THE APP')

    // Saving against the fresh mtime succeeds and returns the new token.
    const ok = await api('PUT', `/api/note?vault=${attached}`, {
      path: 'Home.md', content: '# Home\nresolved in app\n', baseMtime: after.body.mtime,
    })
    expect(ok.status).toBe(200)
    expect(typeof ok.body.mtime).toBe('number')
  })

  it('reports externally changed notes through the changes poll', async () => {
    const first = await api('GET', `/api/changes?vault=${attached}&since=0`)
    if (!first.body.watching) return // recursive watch unsupported here
    const startRev = first.body.rev

    writeFileSync(join(localCheckout, 'sub', 'Ideas.md'), 'changed by another program\n')

    let seen = null
    for (let i = 0; i < 40 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const poll = await api('GET', `/api/changes?vault=${attached}&since=${startRev}`)
      if (poll.body.rev !== startRev) seen = poll.body
    }
    expect(seen).not.toBeNull()
    expect(seen.changed).toContain('sub/Ideas.md')
  })
})
