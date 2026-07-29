/**
 * @md-notebook/core-notes — note parsing, wikilinks, backlinks, tags, search.
 *
 * Extraction is text-based with code masking (fenced blocks + inline code are
 * blanked before scanning) so [[links]] and #tags inside code never register.
 * The remark render pipeline lives in the app package; this package only
 * indexes.
 */
import MiniSearch from 'minisearch'
import { parse as parseYaml } from 'yaml'
import type { Backlink, NoteMetadata, SearchResult, WikiLink } from '@md-notebook/types'

export interface NoteRef {
  /** Vault-relative posix path. */
  path: string
  /** Display title (frontmatter title or filename without extension). */
  title: string
}

export interface SearchDoc {
  path: string
  title: string
  content: string
}

const WIKILINK_RE = /\[\[([^\][|\n]+?)(?:\|([^\]\n]+?))?\]\]/g
const TAG_RE = /(?:^|[\s(])#([A-Za-z0-9][\w/-]*)/gm

/** Blank out fenced code blocks and inline code, preserving line structure. */
function maskCode(src: string): string {
  let out = src.replace(/```[\s\S]*?(?:```|$)/g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  return out
}

/** Filename without directories or .md extension. */
export function noteBasename(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.replace(/\.md$/i, '')
}

/** Split YAML frontmatter (--- fenced at top of file) from the body. */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>
  body: string
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  if (!m) return { data: {}, body: content }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    // Malformed YAML: treat as no frontmatter rather than failing the parse.
  }
  return { data, body: content.slice(m[0].length) }
}

/** Resolve a wikilink target against known notes by title, then filename. */
export function resolveTarget(target: string, notes: NoteRef[]): string | null {
  const want = target.trim().toLowerCase()
  for (const n of notes) if (n.title.toLowerCase() === want) return n.path
  for (const n of notes) if (noteBasename(n.path).toLowerCase() === want) return n.path
  return null
}

/** Extract [[Target]] / [[Target|alias]] links. Dangling links resolve to null. */
export function extractWikiLinks(content: string, notes: NoteRef[] = []): WikiLink[] {
  const masked = maskCode(content)
  const links: WikiLink[] = []
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = m[1].trim()
    if (!target) continue
    links.push({
      target,
      alias: m[2]?.trim(),
      resolvedPath: resolveTarget(target, notes),
    })
  }
  return links
}

/** Extract inline #tags (word-boundary; code is masked first). */
export function extractTags(content: string): string[] {
  const masked = maskCode(content)
  const tags = new Set<string>()
  for (const m of masked.matchAll(TAG_RE)) tags.add(m[1])
  return [...tags]
}

/** Parse one note into frontmatter + tags + links. */
export function parseNote(path: string, content: string, notes: NoteRef[] = []): NoteMetadata {
  const { data, body } = parseFrontmatter(content)
  const fmTags = Array.isArray(data.tags) ? data.tags.map(String) : []
  return {
    frontmatter: data,
    tags: [...new Set([...fmTags, ...extractTags(body)])],
    links: extractWikiLinks(body, notes),
  }
}

/** Title for a note: frontmatter `title` if present, else the filename. */
export function noteTitle(path: string, content: string): string {
  const { data } = parseFrontmatter(content)
  return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : noteBasename(path)
}

/** Build target-path -> backlinks map for a whole vault. */
export function buildBacklinks(notes: Map<string, string>): Map<string, Backlink[]> {
  const refs: NoteRef[] = [...notes].map(([path, content]) => ({ path, title: noteTitle(path, content) }))
  const out = new Map<string, Backlink[]>()
  for (const [sourcePath, content] of notes) {
    const body = maskCode(parseFrontmatter(content).body)
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(WIKILINK_RE)) {
        const resolved = resolveTarget(m[1], refs)
        if (!resolved || resolved === sourcePath) continue
        const list = out.get(resolved) ?? []
        list.push({ sourcePath, line: i + 1, context: lines[i].trim().slice(0, 160) })
        out.set(resolved, list)
      }
    }
  }
  return out
}

const MINI_OPTIONS = {
  idField: 'path',
  fields: ['title', 'content'],
  storeFields: ['title'],
  searchOptions: { boost: { title: 2 }, prefix: true },
}

/** Full-text index over notes (filename + content), persistable to JSON. */
export class SearchIndex {
  private mini: MiniSearch<SearchDoc>
  private docs = new Map<string, SearchDoc>()

  constructor(docs: SearchDoc[] = []) {
    this.mini = new MiniSearch<SearchDoc>(MINI_OPTIONS)
    for (const d of docs) this.add(d)
  }

  add(doc: SearchDoc): void {
    if (this.docs.has(doc.path)) return this.update(doc)
    this.docs.set(doc.path, doc)
    this.mini.add(doc)
  }

  update(doc: SearchDoc): void {
    const prev = this.docs.get(doc.path)
    if (prev) this.mini.remove(prev)
    this.docs.set(doc.path, doc)
    this.mini.add(doc)
  }

  remove(path: string): void {
    const prev = this.docs.get(path)
    if (!prev) return
    this.mini.remove(prev)
    this.docs.delete(path)
  }

  search(query: string): SearchResult[] {
    return this.mini.search(query).map((r) => {
      const content = this.docs.get(String(r.id))?.content ?? ''
      const term: string | undefined = r.terms[0]
      const at = term ? content.toLowerCase().indexOf(term.toLowerCase()) : -1
      return {
        path: String(r.id),
        title: String(r.title ?? ''),
        score: r.score,
        snippet: at >= 0 ? content.slice(Math.max(0, at - 40), at + 80).trim() : undefined,
      }
    })
  }

  toJSON(): string {
    return JSON.stringify({ docs: [...this.docs.values()] })
  }

  static fromJSON(json: string): SearchIndex {
    const payload = JSON.parse(json) as { docs: SearchDoc[] }
    return new SearchIndex(payload.docs)
  }
}
