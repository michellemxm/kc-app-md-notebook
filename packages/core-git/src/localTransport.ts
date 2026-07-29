import path from 'node:path'
import { fs, git, remoteUrlToPath } from './internal.js'

/**
 * Pure-JS transport for LOCAL (`file://` / path) remotes.
 *
 * isomorphic-git's HTTP client only speaks the git-over-HTTP smart protocol and
 * rejects `file://` with UnknownTransportError. To keep the library pure-JS
 * (never shelling out to system git) while still supporting local fixture repos
 * in tests, we transfer git objects between two on-disk repositories using
 * isomorphic-git's own object read/write primitives. Object identity is
 * content-addressed, so re-writing an object reproduces its original oid.
 */

async function hasObject(gitdir: string, oid: string): Promise<boolean> {
  try {
    await git.readObject({ fs, gitdir, oid, format: 'content' })
    return true
  } catch {
    return false
  }
}

async function copyObject(
  srcGitdir: string,
  dstGitdir: string,
  oid: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(oid)) return
  seen.add(oid)
  if (await hasObject(dstGitdir, oid)) return
  const { type, object } = await git.readObject({ fs, gitdir: srcGitdir, oid, format: 'content' })
  await git.writeObject({
    fs,
    gitdir: dstGitdir,
    type: type as 'blob' | 'tree' | 'commit' | 'tag',
    object: object as Uint8Array,
    format: 'content',
  })
}

async function copyTree(
  srcGitdir: string,
  dstGitdir: string,
  treeOid: string,
  seen: Set<string>,
): Promise<void> {
  if (await hasObject(dstGitdir, treeOid)) return
  await copyObject(srcGitdir, dstGitdir, treeOid, seen)
  const { tree } = await git.readTree({ fs, gitdir: srcGitdir, oid: treeOid })
  for (const entry of tree) {
    if (entry.type === 'tree') await copyTree(srcGitdir, dstGitdir, entry.oid, seen)
    else if (entry.type === 'blob') await copyObject(srcGitdir, dstGitdir, entry.oid, seen)
    // submodule ('commit') entries are intentionally skipped
  }
}

/**
 * Copy a commit and its full ancestry, pruning at objects already present in
 * dst. Dedup/cycle-safety comes from the `hasObject(dst)` check (commits form a
 * DAG and become present once copied); `seen` is passed to the object copiers
 * only, so it must NOT gate the commit oid itself here.
 */
async function copyCommitGraph(
  srcGitdir: string,
  dstGitdir: string,
  oid: string,
  seen: Set<string>,
): Promise<void> {
  if (await hasObject(dstGitdir, oid)) return // commit present => ancestry + trees present
  const { commit } = await git.readCommit({ fs, gitdir: srcGitdir, oid })
  await copyObject(srcGitdir, dstGitdir, oid, seen)
  await copyTree(srcGitdir, dstGitdir, commit.tree, seen)
  for (const parent of commit.parent) await copyCommitGraph(srcGitdir, dstGitdir, parent, seen)
}

export interface LocalCloneOptions {
  url: string
  dir: string
  branch: string
  depth: number
}

/** Shallow (depth-limited) clone of a local remote into a fresh working tree. */
export async function localClone(opts: LocalCloneOptions): Promise<void> {
  const remoteGitdir = remoteUrlToPath(opts.url)
  const { dir, branch, depth } = opts
  const dstGitdir = path.join(dir, '.git')

  await git.init({ fs, dir, defaultBranch: branch })
  const tip = await git.resolveRef({ fs, gitdir: remoteGitdir, ref: branch })

  const seen = new Set<string>()
  const shallow = new Set<string>()
  let frontier = [tip]
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next: string[] = []
    for (const c of frontier) {
      const { commit } = await git.readCommit({ fs, gitdir: remoteGitdir, oid: c })
      await copyObject(remoteGitdir, dstGitdir, c, seen)
      await copyTree(remoteGitdir, dstGitdir, commit.tree, seen)
      if (level < depth) next.push(...commit.parent)
      else if (commit.parent.length) shallow.add(c) // boundary: parents excluded
    }
    frontier = next
  }

  await git.writeRef({ fs, gitdir: dstGitdir, ref: `refs/heads/${branch}`, value: tip, force: true })
  await git.writeRef({
    fs,
    gitdir: dstGitdir,
    ref: `refs/remotes/origin/${branch}`,
    value: tip,
    force: true,
  })
  await git.writeRef({
    fs,
    gitdir: dstGitdir,
    ref: 'HEAD',
    value: `refs/heads/${branch}`,
    symbolic: true,
    force: true,
  })
  if (shallow.size) {
    fs.writeFileSync(path.join(dstGitdir, 'shallow'), [...shallow].map((o) => `${o}\n`).join(''))
  }

  await git.setConfig({ fs, dir, path: 'remote.origin.url', value: opts.url })
  await git.setConfig({ fs, dir, path: 'remote.origin.fetch', value: '+refs/heads/*:refs/remotes/origin/*' })
  await git.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: 'origin' })
  await git.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` })

  await git.checkout({ fs, dir, ref: branch, force: true })
}

/**
 * Fetch the latest tip of `branch` from a local remote into `dir`, updating the
 * remote-tracking ref. Returns the fetched tip oid.
 */
export async function localFetch(dir: string, remoteUrl: string, branch: string): Promise<string> {
  const remoteGitdir = remoteUrlToPath(remoteUrl)
  const dstGitdir = path.join(dir, '.git')
  const tip = await git.resolveRef({ fs, gitdir: remoteGitdir, ref: branch })
  await copyCommitGraph(remoteGitdir, dstGitdir, tip, new Set<string>())
  await git.writeRef({
    fs,
    gitdir: dstGitdir,
    ref: `refs/remotes/origin/${branch}`,
    value: tip,
    force: true,
  })
  return tip
}

/**
 * Push local `branch` to a local remote. Fast-forward only: refuses (returns
 * false) if the remote tip is not an ancestor of the local tip.
 */
export async function localPush(dir: string, remoteUrl: string, branch: string): Promise<boolean> {
  const remoteGitdir = remoteUrlToPath(remoteUrl)
  const srcGitdir = path.join(dir, '.git')
  const localOid = await git.resolveRef({ fs, gitdir: srcGitdir, ref: `refs/heads/${branch}` })

  let remoteOid: string | null = null
  try {
    remoteOid = await git.resolveRef({ fs, gitdir: remoteGitdir, ref: branch })
  } catch {
    remoteOid = null
  }
  if (remoteOid === localOid) return false
  if (remoteOid) {
    const ff = await git.isDescendent({
      fs,
      gitdir: srcGitdir,
      oid: localOid,
      ancestor: remoteOid,
      depth: -1,
    })
    if (!ff) return false // non-fast-forward; refuse to clobber remote
  }

  await copyCommitGraph(srcGitdir, remoteGitdir, localOid, new Set<string>())
  await git.writeRef({ fs, gitdir: remoteGitdir, ref: `refs/heads/${branch}`, value: localOid, force: true })
  return true
}
