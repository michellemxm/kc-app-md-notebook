import type { FileChange } from '@md-notebook/types'
import { fs, git } from './internal.js'

export interface StatusOptions {
  /** Restrict results to a subfolder (posix, no leading slash). */
  subfolder?: string
}

/**
 * Compute working-tree changes relative to HEAD as a list of {@link FileChange}.
 * Uses the git status matrix: for each path we compare the working-tree state
 * against HEAD (the stage/index column is ignored).
 */
export async function status(dir: string, opts?: StatusOptions): Promise<FileChange[]> {
  const prefix = opts?.subfolder ? `${opts.subfolder.replace(/\/+$/, '')}/` : null
  const matrix = await git.statusMatrix({ fs, dir })
  const changes: FileChange[] = []

  for (const row of matrix) {
    const filepath = row[0] as string
    const head = row[1] as number // 0 = absent at HEAD, 1 = present
    const workdir = row[2] as number // 0 = absent, 1 = same as HEAD, 2 = different

    let kind: FileChange['kind'] | null = null
    if (head === 0 && workdir > 0) kind = 'added'
    else if (head === 1 && workdir === 0) kind = 'deleted'
    else if (head === 1 && workdir === 2) kind = 'modified'
    if (!kind) continue

    if (prefix && !filepath.startsWith(prefix)) continue
    changes.push({ path: filepath, kind })
  }

  return changes
}
