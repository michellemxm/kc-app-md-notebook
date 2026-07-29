import { randomUUID } from 'node:crypto'
import type { Vault } from '@md-notebook/types'
import { fs, git, http, buildAuth, isLocalRemote, repoName, repoSlug, type AuthCallback } from './internal.js'
import { localClone } from './localTransport.js'

export interface CloneVaultOptions {
  /** Remote URL. HTTPS for real repos, or a `file://` path for local fixtures. */
  url: string
  /** Absolute path for the local clone. */
  dir: string
  /** Branch to track. Defaults to `main`. */
  branch?: string
  /** Shallow clone depth. Defaults to 1. */
  depth?: number
  /** Optional subfolder scope inside the repo (posix, no leading slash) for reads. */
  subfolder?: string
  /** Personal Access Token for HTTPS auth (wrapped into an onAuth handler). */
  pat?: string
  /** Explicit auth callback (takes precedence over `pat`). */
  onAuth?: AuthCallback
  /** Override the derived vault display name. */
  name?: string
  /** Override the generated vault id. */
  id?: string
  /** Mark the vault read-only. Defaults to false. */
  readOnly?: boolean
}

/**
 * Shallow-clone a remote vault to a local directory and return its {@link Vault}
 * descriptor. Supports optional PAT auth (HTTPS) and subfolder scoping for reads.
 */
export async function cloneVault(opts: CloneVaultOptions): Promise<Vault> {
  const branch = opts.branch ?? 'main'
  const depth = opts.depth ?? 1
  const onAuth = buildAuth(opts)

  if (isLocalRemote(opts.url)) {
    await localClone({ url: opts.url, dir: opts.dir, branch, depth })
  } else {
    await git.clone({
      fs,
      http,
      dir: opts.dir,
      url: opts.url,
      ref: branch,
      singleBranch: true,
      depth,
      ...(onAuth ? { onAuth } : {}),
    })
  }

  return {
    id: opts.id ?? randomUUID(),
    name: opts.name ?? repoName(opts.url),
    repo: repoSlug(opts.url),
    ...(opts.subfolder ? { subfolder: opts.subfolder } : {}),
    localPath: opts.dir,
    branch,
    readOnly: opts.readOnly ?? false,
  }
}
