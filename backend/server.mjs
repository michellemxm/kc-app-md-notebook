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
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { cloneVault, status, sync } from '@md-notebook/core-git'
import { SearchIndex, buildBacklinks, noteTitle, parseNote } from '@md-notebook/core-notes'

const HOME = process.env.MD_NOTEBOOK_HOME
  ?? join(homedir(), '.kiro', 'crew', 'workspace', 'md-notebook')
const VAULTS_JSON = join(HOME, 'vaults.json')
const PAT_FILE = join(HOME, 'pat')
const PORT = Number(process.env.PORT ?? 9137)

/** vaultId -> { index: SearchIndex, backlinks: Map, statuses: Map } */
const caches = new Map()

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
  'GET /health': async (req, res) => send(res, 200, { ok: true }),

  'GET /api/vaults': async (req, res) => {
    send(res, 200, { vaults: await readVaults(), hasPat: Boolean(await readPat()) })
  },

  /** Connect a vault: { url, name?, branch?, subfolder?, pat? } */
  'POST /api/vaults': async (req, res) => {
    const body = await readBody(req)
    if (!body.url) return send(res, 400, { error: 'url is required' })
    if (body.pat) await writePat(body.pat)
    const pat = await readPat()
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

  'GET /api/notes': async (req, res, url) => {
    const vault = await requireVault(url)
    send(res, 200, { notes: await noteListing(vault) })
  },

  'GET /api/note': async (req, res, url) => {
    const vault = await requireVault(url)
    const path = url.searchParams.get('path')
    if (!path) return send(res, 400, { error: 'path is required' })
    const abs = safeJoin(contentRoot(vault), path)
    const content = await fsp.readFile(abs, 'utf8')
    const cache = await getCache(vault)
    send(res, 200, {
      path,
      content,
      meta: parseNote(path, content),
      backlinks: cache.backlinks.get(path) ?? [],
    })
  },

  /** Create or save a note: { path, content } */
  'PUT /api/note': async (req, res, url) => {
    const vault = await requireVault(url)
    if (vault.readOnly) return send(res, 403, { error: 'vault is read-only' })
    const { path, content } = await readBody(req)
    if (!path || typeof content !== 'string') return send(res, 400, { error: 'path and content required' })
    const abs = safeJoin(contentRoot(vault), path)
    await fsp.mkdir(dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
    const cache = await getCache(vault)
    cache.index.update({ path, title: noteTitle(path, content), content })
    const root = contentRoot(vault)
    const paths = await listNoteFiles(root)
    const notes = new Map()
    for (const p of paths) notes.set(p, await fsp.readFile(join(root, p), 'utf8'))
    cache.backlinks = buildBacklinks(notes)
    send(res, 200, { ok: true })
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
    const result = await sync(vault.localPath, { branch: vault.branch, pat: await readPat() })
    await rebuildCache(vault)
    send(res, 200, { result })
  },

  'GET /api/search': async (req, res, url) => {
    const vault = await requireVault(url)
    const q = url.searchParams.get('q') ?? ''
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
