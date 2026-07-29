import type { ConflictVersions, FileChange, SyncResult } from '@md-notebook/types'
import {
  fs,
  git,
  http,
  buildAuth,
  isLocalRemote,
  readFileAtCommit,
  DEFAULT_AUTHOR,
  type Author,
  type AuthCallback,
} from './internal.js'
import { status } from './status.js'
import { autoCommit } from './commit.js'
import { localFetch, localPush } from './localTransport.js'

export interface SyncOptions {
  /** Branch to sync. Defaults to the current branch (or `main`). */
  branch?: string
  /** Commit author for auto-commit and merge commits. */
  author?: Author
  /** Personal Access Token for HTTPS auth. */
  pat?: string
  /** Explicit auth callback (takes precedence over `pat`). */
  onAuth?: AuthCallback
}

async function pushBranch(
  dir: string,
  remoteUrl: string,
  branch: string,
  onAuth: AuthCallback | undefined,
  local: boolean,
): Promise<boolean> {
  if (local) return localPush(dir, remoteUrl, branch)
  const res = await git.push({ fs, http, dir, remote: 'origin', ref: branch, ...(onAuth ? { onAuth } : {}) })
  return Boolean(res.ok)
}

/**
 * Sync a local vault with its remote: commit local changes, fetch, merge, and
 * push. On a merge conflict the working tree is left untouched (the local
 * committed content stays on disk) and the returned {@link SyncResult} carries
 * every conflicted path with BOTH the local and remote versions — nothing is
 * overwritten.
 */
export async function sync(dir: string, opts?: SyncOptions): Promise<SyncResult> {
  const onAuth = buildAuth(opts)
  const author = {
    name: opts?.author?.name ?? DEFAULT_AUTHOR.name,
    email: opts?.author?.email ?? DEFAULT_AUTHOR.email,
  }
  const branch =
    opts?.branch ?? (await git.currentBranch({ fs, dir, fullname: false })) ?? 'main'

  const remoteUrl = await git.getConfig({ fs, dir, path: 'remote.origin.url' })
  if (!remoteUrl) throw new Error(`No remote.origin.url configured for ${dir}`)
  const local = isLocalRemote(remoteUrl)

  // 1. Commit any local working-tree changes so they are part of history.
  const pending = await status(dir)
  let committed: FileChange[] = []
  if (pending.length > 0) {
    const result = await autoCommit(dir, undefined, { author })
    committed = result.committed
  }

  // 2. Fetch the remote tip.
  let remoteOid: string
  if (local) {
    remoteOid = await localFetch(dir, remoteUrl, branch)
  } else {
    const res = await git.fetch({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: branch,
      singleBranch: true,
      tags: false,
      ...(onAuth ? { onAuth } : {}),
    })
    remoteOid =
      res.fetchHead ?? (await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }))
  }
  const localOid = await git.resolveRef({ fs, dir, ref: branch })

  // Already in sync — nothing to merge or push.
  if (remoteOid === localOid) {
    return { pushed: false, pulled: false, committed, conflicts: [] }
  }

  // 3. Merge remote into local. abortOnConflict keeps the working tree intact.
  try {
    const merged = await git.merge({
      fs,
      dir,
      ours: branch,
      theirs: remoteOid,
      author,
      abortOnConflict: true,
    })
    await git.checkout({ fs, dir, ref: branch, force: true })
    const pulled = !merged.alreadyMerged

    // 4. Push the (possibly merged) branch back to the remote.
    const pushed = await pushBranch(dir, remoteUrl, branch, onAuth, local)
    return { pushed, pulled, committed, conflicts: [] }
  } catch (err) {
    const e = err as { code?: string; name?: string; data?: { filepaths?: string[] } }
    if (e.code === 'MergeConflictError' || e.name === 'MergeConflictError') {
      const filepaths = e.data?.filepaths ?? []
      const conflicts: ConflictVersions[] = []
      for (const filepath of filepaths) {
        conflicts.push({
          path: filepath,
          local: (await readFileAtCommit(dir, localOid, filepath)) ?? '',
          remote: (await readFileAtCommit(dir, remoteOid, filepath)) ?? '',
        })
      }
      return { pushed: false, pulled: false, committed, conflicts }
    }
    throw err
  }
}
