import { describe, expect, it } from 'vitest'
import {
  SearchIndex,
  buildBacklinks,
  extractTags,
  extractWikiLinks,
  parseFrontmatter,
  parseNote,
} from '../src/index'

const REFS = [
  { path: 'projects/Roadmap.md', title: 'Roadmap' },
  { path: 'daily/2026-07-28.md', title: 'Standup Notes' },
]

describe('wikilinks', () => {
  it('parses [[Target]] and [[Target|alias]]', () => {
    const links = extractWikiLinks('See [[Roadmap]] and [[Standup Notes|today]].', REFS)
    expect(links).toEqual([
      { target: 'Roadmap', alias: undefined, resolvedPath: 'projects/Roadmap.md' },
      { target: 'Standup Notes', alias: 'today', resolvedPath: 'daily/2026-07-28.md' },
    ])
  })

  it('flags dangling links with resolvedPath null', () => {
    const [link] = extractWikiLinks('[[Does Not Exist]]', REFS)
    expect(link.target).toBe('Does Not Exist')
    expect(link.resolvedPath).toBeNull()
  })

  it('resolves by filename when no title matches', () => {
    const [link] = extractWikiLinks('[[2026-07-28]]', REFS)
    expect(link.resolvedPath).toBe('daily/2026-07-28.md')
  })

  it('ignores links inside code fences and inline code', () => {
    const md = 'real [[Roadmap]]\n```\n[[Fenced]]\n```\nand `[[Inline]]`'
    expect(extractWikiLinks(md, REFS)).toHaveLength(1)
  })
})

describe('frontmatter and tags', () => {
  it('parses YAML frontmatter and strips it from the body', () => {
    const { data, body } = parseFrontmatter('---\ntitle: My Note\ntags: [a, b]\n---\nBody')
    expect(data.title).toBe('My Note')
    expect(body).toBe('Body')
  })

  it('extracts inline #tags but not inside code fences', () => {
    expect(extractTags('hello #alpha and #beta/x\n```\n#fenced\n```')).toEqual(['alpha', 'beta/x'])
  })

  it('parseNote merges frontmatter tags with inline tags', () => {
    const meta = parseNote('n.md', '---\ntags: [fm]\n---\nBody #inline [[Roadmap]]', REFS)
    expect(meta.tags).toEqual(['fm', 'inline'])
    expect(meta.links[0].resolvedPath).toBe('projects/Roadmap.md')
  })
})

describe('backlinks', () => {
  it('maps target -> sources with 1-based line numbers', () => {
    const notes = new Map([
      ['a.md', 'first line\nlinks to [[b]] here'],
      ['b.md', 'no links'],
    ])
    const back = buildBacklinks(notes)
    expect(back.get('b.md')).toEqual([
      { sourcePath: 'a.md', line: 2, context: 'links to [[b]] here' },
    ])
  })
})

describe('SearchIndex', () => {
  const docs = [
    { path: 'a.md', title: 'Alpha Plan', content: 'quarterly goals and metrics' },
    { path: 'b.md', title: 'Beta', content: 'meeting notes about goals' },
  ]

  it('finds notes by title and content', () => {
    const idx = new SearchIndex(docs)
    expect(idx.search('alpha')[0].path).toBe('a.md')
    expect(idx.search('goals').map((r) => r.path).sort()).toEqual(['a.md', 'b.md'])
  })

  it('supports incremental update and remove', () => {
    const idx = new SearchIndex(docs)
    idx.update({ path: 'b.md', title: 'Beta', content: 'now about zebras' })
    expect(idx.search('goals').map((r) => r.path)).toEqual(['a.md'])
    idx.remove('a.md')
    expect(idx.search('goals')).toHaveLength(0)
  })

  it('round-trips through toJSON/fromJSON', () => {
    const idx = new SearchIndex(docs)
    const restored = SearchIndex.fromJSON(idx.toJSON())
    expect(restored.search('goals').map((r) => r.path).sort()).toEqual(['a.md', 'b.md'])
  })
})
