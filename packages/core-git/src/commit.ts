import type { FileChange } from '@md-notebook/types'
import { fs, git, DEFAULT_AUTHOR, type Author } from './internal.js'
import { status } from './status.js'

export interface AutoCommitOptions {
  /** Override the commit author (name/email). */
  author?: Author
}

export interface CommitResult {
  /** The new commit oid, or null when there was nothing to commit. */
  oid: string | null
  /** The commit message used (empty when nothing was committed). */
  message: string
  /** The files included in the commit. */
  committed: FileChange[]
}

/** Generate a commit message: `Update <filename>` for a single-file change. */
function generateMessage(changes: FileChange[]): string {
  if (changes.length === 1) {
    const name = changes[0].path.split('/').pop() ?? changes[0].path
    return `Update ${name}`
  }
  return `Update ${changes.length} files`
}

/**
 * Stage all working-tree changes and commit them. When no `message` is given, a
 * message is generated (`Update <filename>` for single-file changes). Returns
 * a null oid when the working tree is clean.
 */
export async function autoCommit(
  dir: string,
  message?: string,
  opts?: AutoCommitOptions,
): Promise<CommitResult> {
  const changes = await status(dir)
  if (changes.length === 0) return { oid: null, message: '', committed: [] }

  for (const change of changes) {
    if (change.kind === 'deleted') await git.remove({ fs, dir, filepath: change.path })
    else await git.add({ fs, dir, filepath: change.path })
  }

  const finalMessage = message ?? generateMessage(changes)
  const author = {
    name: opts?.author?.name ?? DEFAULT_AUTHOR.name,
    email: opts?.author?.email ?? DEFAULT_AUTHOR.email,
  }
  const oid = await git.commit({ fs, dir, message: finalMessage, author })

  return { oid, message: finalMessage, committed: changes }
}
