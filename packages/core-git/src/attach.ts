import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { Vault } from '@md-notebook/types'
import { fs, git, repoName, repoSlug } from './internal.js'

export interface AttachVaultOptions {
  /** Absolute path to an existing git working tree. */
  dir: string
  /** Optional subfolder scope inside the repo (posix, no leading slash) for reads. */
  subfolder?: string
  /** Override the derived vault display name. */
  name?: string
  /** Override the generated vault id. */
  id?: string
  /** Mark the vault read-only. Defaults to false. */
  readOnly?: boolean
}

/** Thrown when the directory can't serve as a vault. `code` is UI-friendly. */
export class AttachError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AttachError'
  }
}

/**
 * Adopt an EXISTING local git working tree as a vault — no clone, no second
 * copy on disk. Reads the repo's own `remote.origin.url` and current branch so
 * sync targets exactly what the user's git already tracks.
 *
 * Unlike {@link cloneVault} this points at a directory the user also drives
 * with their own tooling, so the caller is responsible for change detection
 * (the backend watches the tree) and for guarding saves against concurrent
 * external edits.
 */
export async function attachVault(opts: AttachVaultOptions): Promise<Vault> {
  const dir = opts.dir
  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    throw new AttachError(`Folder not found: ${dir}`, 'ENOENT')
  }
  if (!st.isDirectory()) throw new AttachError(`Not a folder: ${dir}`, 'ENOTDIR')

  // Require a real working tree: .git may be a directory (normal clone) or a
  // file (worktree / submodule pointer), both acceptable.
  try {
    await fsp.stat(join(dir, '.git'))
  } catch {
    throw new AttachError(`Not a git repository (no .git found): ${dir}`, 'ENOGIT')
  }

  if (opts.subfolder) {
    try {
      const sub = await fsp.stat(join(dir, opts.subfolder))
      if (!sub.isDirectory()) throw new Error('not a dir')
    } catch {
      throw new AttachError(`Subfolder not found in repo: ${opts.subfolder}`, 'ENOSUB')
    }
  }

  const url = await git.getConfig({ fs, dir, path: 'remote.origin.url' })
  if (!url) throw new AttachError(`Repository has no remote.origin.url: ${dir}`, 'ENOREMOTE')

  const branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? 'main'

  return {
    id: opts.id ?? randomUUID(),
    name: opts.name ?? repoName(url) ?? basename(dir),
    repo: repoSlug(url),
    ...(opts.subfolder ? { subfolder: opts.subfolder } : {}),
    localPath: dir,
    branch,
    readOnly: opts.readOnly ?? false,
  }
}
