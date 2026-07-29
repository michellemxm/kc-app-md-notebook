/**
 * md-notebook backend — Node HTTP server for the KiroCrew app.
 *
 * Launched by the KiroCrew gateway (app.json backend.entryPoint); the port
 * arrives via env PORT. Binds to 127.0.0.1 ONLY. Wraps @md-notebook/core-git
 * (vault clone/sync) and @md-notebook/core-notes (index/backlinks/search).
 *
 * State layout (overridable via MD_NOTEBOOK_HOME for tests):
 *   <home>/vaults.json          vault descriptors (no secrets)
 *   <home>/pat                  PAT, chmod 0600
 *   <home>/vaults/<id>/         local clones
 */
import { createServer } from 'node:http'
import { promises as fsp, statSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { cloneVault, attachVault, AttachError, status, sync } from '@md-notebook/core-git'
import { SearchIndex, buildBacklinks, noteTitle, parseNote } from '@md-notebook/core-notes'

const HOME = process.env.MD_NOTEBOOK_HOME
  ?? join(homedir(), '.kiro', 'crew', 'workspace', 'md-notebook')
const VAULTS_JSON = join(HOME, 'vaults.json')
const PAT_FILE = join(HOME, 'pat')
const PORT = Number(process.env.PORT ?? 9137)

/** vaultId -> { index: SearchIndex, backlinks: Map, statuses: Map } */
const caches = new Map()

// ---------- external-change watcher ----------
//
// An attached vault points at a folder the user also edits with their own
// tooling (Obsidian, editors, git CLI), so the backend must notice changes it
// did not make. Each watched vault keeps a monotonic revision the UI polls via
// GET /api/changes; a bump means "re-read the listing, and the open note if it
// is in `paths`".
//
/** vaultId -> { watcher, rev, paths:Set, stale:boolean, timer } */
const watches = new Map()
/** absPath -> ms timestamp of our own last write, to ignore self-inflicted events. */
const selfWrites = new Map()
const SELF_WRITE_GRACE_MS = 1500

function markSelfWrite(abs) {
  selfWrites.set(abs, Date.now())
  // Bound the map: drop entries that can no longer suppress anything.
  if (selfWrites.size > 200) {
    const cutoff = Date.now() - SELF_WRITE_GRACE_MS
    for (const [k, t] of selfWrites) if (t < cutoff) selfWrites.delete(k)
  }
}

function watchState(vault) {
  let w = watches.get(vault.id)
  if (w) return w
  w = { watcher: null, rev: 0, paths: new Set(), stale: false, timer: null }
  watches.set(vault.id, w)
  const root = contentRoot(vault)
  try {
    // Recursive watch is supported on macOS (FSEvents) and Windows; on Linux
    // it needs Node >= 20. A failure here is non-fatal — the app simply falls
    // back to refresh-on-interaction, so attach still works.
    w.watcher = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return
      const rel = String(filename).split(sep).join('/')
      if (!rel.endsWith('.md') || rel.startsWith('.git/')) return
      const abs = join(root, rel)
      const self = selfWrites.get(abs)
      if (self && Date.now() - self < SELF_WRITE_GRACE_MS) return
      w.paths.add(rel)
      w.stale = true
      // Coalesce bursts (editors write via temp-file rename, git touches many
      // files at once) into a single revision bump.
      if (w.timer) clearTimeout(w.timer)
      w.timer = setTimeout(() => { w.rev += 1; w.timer = null }, 150)
    })
    w.watcher.on('error', () => { /* watch lost; polling still returns rev */ })
  } catch (err) {
    console.warn(`md-notebook: cannot watch ${root}: ${err.message}`)
  }
  return w
}

/** Rebuild the search index + backlinks if the tree changed underneath us. */
async function freshenCache(vault) {
  const w = watches.get(vault.id)
  if (w?.stale) { w.stale = false; await rebuildCache(vault) }
}

// ---------- persistence ----------

async function readVaults() {
  try { return JSON.parse(await fsp.readFile(VAULTS_JSON, 'utf8')) } catch { return [] }
}
async function writeVaults(vaults) {
  await fsp.mkdir(HOME, { recursive: true })
  await fsp.writeFile(VAULTS_JSON, JSON.stringify(vaults, null, 2))
}
async function readPat() {
  try { return (await fsp.readFile(PAT_FILE, 'utf8')).trim() || undefined } catch { return undefined }
}
async function writePat(pat) {
  await fsp.mkdir(HOME, { recursive: true })
  await fsp.writeFile(PAT_FILE, pat, { mode: 0o600 })
}

// ---------- GitHub CLI auth fallback ----------
// Kiro Crew's GitHub connection is the user's `gh` CLI login. When no PAT is
// stored, mint a token from it on demand (never persisted to disk).
import { execFile } from 'node:child_process'

function findGh() {
  for (const c of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', join(homedir(), '.local', 'bin', 'gh')]) {
    try { if (statSync(c).isFile()) return c } catch { /* keep looking */ }
  }
  return 'gh' // hope PATH has it
}

let ghTokenCache = { value: undefined, at: 0 }
async function ghToken() {
  if (Date.now() - ghTokenCache.at < 300_000) return ghTokenCache.value
  const value = await new Promise((resolve) => {
    execFile(findGh(), ['auth', 'token'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined)
    })
  })
  ghTokenCache = { value, at: Date.now() }
  return value
}

/** Auth for git operations: explicit stored PAT wins, else gh CLI login. */
async function resolveAuth() {
  return (await readPat()) ?? (await ghToken())
}

// ---------- vault scanning ----------

/** Recursively list .md files (vault-relative posix paths), skipping .git. */
async function listNoteFiles(root, rel = '') {
  const out = []
  const entries = await fsp.readdir(join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    if (e.name === '.git' || e.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await listNoteFiles(root, childRel))
    else if (e.name.toLowerCase().endsWith('.md')) out.push(childRel)
  }
  return out
}

/** Resolve a note path inside the vault root, rejecting traversal. */
function safeJoin(root, relPath) {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('path escapes vault')
  return abs
}

function contentRoot(vault) {
  return vault.subfolder ? join(vault.localPath, vault.subfolder) : vault.localPath
}

/** (Re)build the search index + backlinks for a vault from disk. */
async function rebuildCache(vault) {
  const root = contentRoot(vault)
  const paths = await listNoteFiles(root)
  const notes = new Map()
  await Promise.all(paths.map(async (p) => {
    notes.set(p, await fsp.readFile(join(root, p), 'utf8'))
  }))
  const docs = [...notes].map(([path, content]) => ({ path, title: noteTitle(path, content), content }))
  const cache = {
    index: new SearchIndex(docs),
    backlinks: buildBacklinks(notes),
    statuses: new Map(),
  }
  caches.set(vault.id, cache)
  return cache
}

async function getCache(vault) {
  return caches.get(vault.id) ?? rebuildCache(vault)
}

async function refreshStatuses(vault, cache) {
  const changes = await status(vault.localPath)
  cache.statuses = new Map(changes.map((c) => [c.path, 'pending']))
}

async function noteListing(vault) {
  const root = contentRoot(vault)
  const cache = await getCache(vault)
  await refreshStatuses(vault, cache)
  const paths = await listNoteFiles(root)
  const prefix = vault.subfolder ? `${vault.subfolder}/` : ''
  return Promise.all(paths.map(async (p) => {
    const st = await fsp.stat(join(root, p))
    const content = await fsp.readFile(join(root, p), 'utf8')
    return {
      path: p,
      title: noteTitle(p, content),
      modifiedAt: st.mtimeMs,
      // Creation time. birthtimeMs is real on APFS/HFS+; filesystems without
      // it report 0, so fall back to ctime (inode change) then mtime.
      createdAt: st.birthtimeMs || st.ctimeMs || st.mtimeMs,
      syncStatus: cache.statuses.get(prefix + p) ?? 'synced',
    }
  }))
}

// ---------- request plumbing ----------

function send(res, code, body) {
  const json = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(json)
}

async function readBody(req) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 5_000_000) throw new Error('body too large')
  }
  return data ? JSON.parse(data) : {}
}

async function requireVault(url) {
  const vaults = await readVaults()
  const id = url.searchParams.get('vault') ?? vaults[0]?.id
  const vault = vaults.find((v) => v.id === id)
  if (!vault) throw Object.assign(new Error('no vault connected'), { code: 404 })
  return vault
}

// ---------- routes ----------

const routes = {
  /**
   * Health + capability probe. `features` lets the UI detect a backend process
   * running older code than the UI bundle (the gateway keeps an app's backend
   * alive across UI reloads, so a stale process would otherwise surface as
   * confusing "no route" errors).
   */
  'GET /health': async (req, res) => send(res, 200, {
    ok: true,
    features: ['createdAt', 'attach', 'changes', 'saveGuard', 'forget', 'pat'],
  }),

  // Same probe under /api so the UI can reach it through the gateway's
  // /apps/<name>/api/* proxy (the bare /health path is the gateway's own check).
  'GET /api/health': async (req, res) => send(res, 200, {
    ok: true,
    features: ['createdAt', 'attach', 'changes', 'saveGuard', 'forget', 'pat'],
  }),

  'GET /api/vaults': async (req, res) => {
    const CLONE_ROOT = join(HOME, 'vaults')
    const vaults = (await readVaults()).map((v) => ({
      ...v,
      // `external` = attached in place (the user's own checkout) rather than
      // cloned into the app's storage. Computed, never persisted.
      external: !v.localPath.startsWith(CLONE_ROOT),
    }))
    send(res, 200, { vaults, hasPat: Boolean(await readPat()), hasGhAuth: Boolean(await ghToken()) })
  },

  /**
   * Forget a vault: { vault } (or ?vault=). Removes the descriptor only —
   * FILES ARE NEVER DELETED, so an attached folder and even an app-made clone
   * stay on disk and can be re-added.
   */
  'DELETE /api/vaults': async (req, res, url) => {
    const id = url.searchParams.get('vault')
    if (!id) return send(res, 400, { error: 'vault is required' })
    const vaults = await readVaults()
    const vault = vaults.find((v) => v.id === id)
    if (!vault) return send(res, 404, { error: 'no such vault' })
    await writeVaults(vaults.filter((v) => v.id !== id))
    caches.delete(id)
    const w = watches.get(id)
    if (w) { try { w.watcher?.close() } catch { /* already gone */ } watches.delete(id) }
    send(res, 200, { ok: true, localPath: vault.localPath })
  },

  /** Set or clear the stored PAT: { pat } — empty/absent clears it. */
  'PUT /api/pat': async (req, res) => {
    const { pat } = await readBody(req)
    if (pat) await writePat(String(pat))
    else await fsp.rm(PAT_FILE, { force: true })
    send(res, 200, { hasPat: Boolean(await readPat()), hasGhAuth: Boolean(await ghToken()) })
  },

  /** Connect a vault: { url, name?, branch?, subfolder?, pat? } */
  'POST /api/vaults': async (req, res) => {
    const body = await readBody(req)
    if (!body.url) return send(res, 400, { error: 'url is required' })
    if (body.pat) await writePat(body.pat)
    const pat = await resolveAuth()
    const vaults = await readVaults()
    const id = `v${Date.now().toString(36)}`
    const vault = await cloneVault({
      url: body.url,
      dir: join(HOME, 'vaults', id),
      id,
      branch: body.branch,
      subfolder: body.subfolder || undefined,
      name: body.name || undefined,
      pat,
    })
    vaults.push(vault)
    await writeVaults(vaults)
    await rebuildCache(vault)
    send(res, 200, { vault })
  },

  /**
   * Attach an EXISTING local git checkout as a vault — no second clone.
   * Body: { path, subfolder?, name? }
   */
  'POST /api/vaults/attach': async (req, res) => {
    const body = await readBody(req)
    if (!body.path) return send(res, 400, { error: 'path is required' })
    const vaults = await readVaults()
    const dir = resolve(String(body.path).replace(/^~(?=$|\/)/, homedir()))
    if (vaults.some((v) => v.localPath === dir)) {
      return send(res, 409, { error: 'that folder is already attached as a vault' })
    }
    let vault
    try {
      vault = await attachVault({
        dir,
        id: `v${Date.now().toString(36)}`,
        subfolder: body.subfolder || undefined,
        name: body.name || undefined,
      })
    } catch (err) {
      if (err instanceof AttachError) return send(res, 400, { error: err.message, code: err.code })
      throw err
    }
    vaults.push(vault)
    await writeVaults(vaults)
    await rebuildCache(vault)
    watchState(vault)
    send(res, 200, { vault })
  },

  /**
   * External-change poll. Returns the vault's current revision plus the note
   * paths touched since the caller's `since` revision, so the UI can refresh
   * its listing and warn about an open note edited outside the app.
   */
  'GET /api/changes': async (req, res, url) => {
    const vault = await requireVault(url)
    const w = watchState(vault)
    const since = Number(url.searchParams.get('since') ?? 0)
    const changed = since === w.rev ? [] : [...w.paths]
    if (since !== w.rev) w.paths.clear()
    send(res, 200, { rev: w.rev, changed, watching: Boolean(w.watcher) })
  },

  'GET /api/notes': async (req, res, url) => {
    const vault = await requireVault(url)
    watchState(vault)
    await freshenCache(vault)
    send(res, 200, { notes: await noteListing(vault) })
  },

  'GET /api/note': async (req, res, url) => {
    const vault = await requireVault(url)
    const path = url.searchParams.get('path')
    if (!path) return send(res, 400, { error: 'path is required' })
    const abs = safeJoin(contentRoot(vault), path)
    const content = await fsp.readFile(abs, 'utf8')
    const st = await fsp.stat(abs)
    const cache = await getCache(vault)
    send(res, 200, {
      path,
      content,
      // Snapshot token for the save guard: PUT rejects if the file changed on
      // disk since this read (i.e. someone edited it outside the app).
      mtime: st.mtimeMs,
      meta: parseNote(path, content),
      backlinks: cache.backlinks.get(path) ?? [],
    })
  },

  /** Create or save a note: { path, content } */
  'PUT /api/note': async (req, res, url) => {
    const vault = await requireVault(url)
    if (vault.readOnly) return send(res, 403, { error: 'vault is read-only' })
    const { path, content, baseMtime } = await readBody(req)
    if (!path || typeof content !== 'string') return send(res, 400, { error: 'path and content required' })
    const abs = safeJoin(contentRoot(vault), path)
    // Save guard (optimistic concurrency): when the caller passes the mtime it
    // read, refuse to write if the file changed underneath — otherwise an edit
    // made outside the app (Obsidian, git pull) would be silently clobbered.
    if (typeof baseMtime === 'number') {
      let current = null
      try { current = (await fsp.stat(abs)).mtimeMs } catch { /* new file: nothing to clobber */ }
      if (current !== null && Math.abs(current - baseMtime) > 1) {
        return send(res, 409, {
          error: 'this note changed on disk since you opened it',
          code: 'ESTALE',
          mtime: current,
          disk: await fsp.readFile(abs, 'utf8'),
        })
      }
    }
    await fsp.mkdir(dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
    markSelfWrite(abs)
    const cache = await getCache(vault)
    cache.index.update({ path, title: noteTitle(path, content), content })
    const root = contentRoot(vault)
    const paths = await listNoteFiles(root)
    const notes = new Map()
    for (const p of paths) notes.set(p, await fsp.readFile(join(root, p), 'utf8'))
    cache.backlinks = buildBacklinks(notes)
    send(res, 200, { ok: true, mtime: (await fsp.stat(abs)).mtimeMs })
  },

  'DELETE /api/note': async (req, res, url) => {
    const vault = await requireVault(url)
    if (vault.readOnly) return send(res, 403, { error: 'vault is read-only' })
    const path = url.searchParams.get('path')
    if (!path) return send(res, 400, { error: 'path is required' })
    await fsp.unlink(safeJoin(contentRoot(vault), path))
    const cache = await getCache(vault)
    cache.index.remove(path)
    send(res, 200, { ok: true })
  },

  'POST /api/sync': async (req, res, url) => {
    const vault = await requireVault(url)
    const result = await sync(vault.localPath, { branch: vault.branch, pat: await resolveAuth() })
    await rebuildCache(vault)
    send(res, 200, { result })
  },

  'GET /api/search': async (req, res, url) => {
    const vault = await requireVault(url)
    const q = url.searchParams.get('q') ?? ''
    await freshenCache(vault)
    const cache = await getCache(vault)
    send(res, 200, { results: q ? cache.index.search(q) : [] })
  },
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // The gateway proxies /apps/md-notebook/api/* to this server; accept both
  // the bare path and the proxied prefix.
  const path = url.pathname.replace(/^\/apps\/md-notebook\/api/, '/api')
  const handler = routes[`${req.method} ${path}`]
  if (!handler) return send(res, 404, { error: `no route: ${req.method} ${path}` })
  try {
    await handler(req, res, url)
  } catch (err) {
    send(res, err.code === 404 ? 404 : 500, { error: String(err.message ?? err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`md-notebook backend on 127.0.0.1:${PORT} (home: ${HOME})`)
})
