import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import http from 'isomorphic-git/http/node'
import * as git from 'isomorphic-git'

export { fs, http, git }

/** Default identity used for generated (auto) commits. */
export const DEFAULT_AUTHOR = { name: 'md-notebook', email: 'noreply@md-notebook.local' } as const

export interface Author {
  name?: string
  email?: string
}

export type AuthCallback = (
  url: string,
) =>
  | { username?: string; password?: string; headers?: Record<string, string> }
  | void
  | Promise<{ username?: string; password?: string; headers?: Record<string, string> } | void>

/**
 * Build an isomorphic-git `onAuth` handler. Prefers an explicit callback,
 * otherwise wraps a Personal Access Token for HTTPS basic auth.
 */
export function buildAuth(opts?: { pat?: string; onAuth?: AuthCallback }): AuthCallback | undefined {
  if (opts?.onAuth) return opts.onAuth
  if (opts?.pat) return () => ({ username: opts.pat as string, password: 'x-oauth-basic' })
  return undefined
}

/** A `file://` URL or a bare filesystem path is treated as a local remote. */
export function isLocalRemote(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('/') || url.startsWith('.')
}

/** Resolve a remote URL (possibly `file://`) to an on-disk gitdir path. */
export function remoteUrlToPath(url: string): string {
  return url.startsWith('file://') ? fileURLToPath(url) : url
}

/** Last path segment of a repo URL, minus any trailing `.git`. */
export function repoName(url: string): string {
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '')
  const seg = trimmed.split(/[\\/]/).pop() ?? trimmed
  return seg || trimmed
}

/** Best-effort `owner/repo` slug from a repo URL. */
export function repoSlug(url: string): string {
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  return repoName(url)
}

/** Read a file's UTF-8 content as it existed at a given commit, or null if absent. */
export async function readFileAtCommit(
  dir: string,
  commitOid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: commitOid, filepath })
    return Buffer.from(blob).toString('utf8')
  } catch {
    return null
  }
}
