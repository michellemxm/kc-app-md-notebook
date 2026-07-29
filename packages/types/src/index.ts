/** Shared contracts for md-notebook (spec T0.2). */

export type SyncStatus = 'synced' | 'pending' | 'conflict'

export interface Vault {
  /** Stable local id. */
  id: string
  /** Display name (defaults to repo name). */
  name: string
  /** e.g. "owner/repo". */
  repo: string
  /** Optional subfolder scope inside the repo (posix path, no leading slash). */
  subfolder?: string
  /** Absolute path of the local clone. */
  localPath: string
  /** Branch tracked for sync. */
  branch: string
  readOnly: boolean
}

export interface Note {
  /** Vault-relative posix path, e.g. "daily/2026-07-28.md". */
  path: string
  /** Title: frontmatter `title` if present, else filename without extension. */
  title: string
  /** Unix ms of last local modification. */
  modifiedAt: number
  /** Unix ms of file creation (birthtime, with ctime/mtime fallback). */
  createdAt: number
  syncStatus: SyncStatus
}

export interface WikiLink {
  /** Raw target as typed, e.g. "My Note" from [[My Note]]. */
  target: string
  /** Optional alias from [[Target|alias]]. */
  alias?: string
  /** Resolved vault-relative path, or null when dangling. */
  resolvedPath: string | null
}

export interface Backlink {
  /** Note containing the link. */
  sourcePath: string
  /** Line number (1-based) of the link occurrence. */
  line: number
  /** Surrounding text snippet for display. */
  context: string
}

export interface NoteMetadata {
  frontmatter: Record<string, unknown>
  tags: string[]
  links: WikiLink[]
}

export interface SearchResult {
  path: string
  title: string
  /** Relevance score (higher = better). */
  score: number
  /** Optional matched-content snippet. */
  snippet?: string
}

export interface FileChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
}

export interface ConflictVersions {
  path: string
  local: string
  remote: string
}

export interface SyncResult {
  pushed: boolean
  pulled: boolean
  committed: FileChange[]
  conflicts: ConflictVersions[]
}
