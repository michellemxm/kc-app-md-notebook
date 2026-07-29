/**
 * MD Notebook — KiroCrew app UI.
 *
 * Single-note view, NO tabs. The left panel is the only navigation surface:
 * search pinned on top, collapsible folder tree below, session-list-style
 * rows (title + relative time + sync badge). Search swaps the tree for flat
 * ranked results; clearing restores the tree.
 */
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const API = '/apps/md-notebook/api'
// Theme integration: the app renders inside the KiroCrew dashboard DOM, so
// these CSS custom properties resolve against the active theme and update
// live when the user changes theme or font settings.
const ACCENT = 'var(--accent)'
const ACCENT_BG = 'var(--accent-subtle)'
const ACCENT_FG = 'var(--accent-fg)'
const FONT_BODY = 'var(--font-body)'
const FONT_MONO = 'var(--mono)'

// ---------- helpers ----------

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

function relTime(ms) {
  const d = Date.now() - ms
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`
  return `${Math.floor(d / 86400e3)}d ago`
}

/** Group flat note list into a folder tree. */
function buildTree(notes) {
  const root = { folders: new Map(), notes: [] }
  for (const n of notes) {
    const parts = n.path.split('/')
    let cur = root
    for (const part of parts.slice(0, -1)) {
      if (!cur.folders.has(part)) cur.folders.set(part, { folders: new Map(), notes: [] })
      cur = cur.folders.get(part)
    }
    cur.notes.push(n)
  }
  return root
}

// ---------- markdown preview (no external deps; renders React nodes) ----------

function inline(text, key) {
  const nodes = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[\[([^\][|]+?)(?:\|([^\]]+?))?\]\])|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1]) nodes.push(h('code', { key: `${key}-${i}`, style: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0 4px', fontSize: '0.9em', fontFamily: FONT_MONO } }, m[1].slice(1, -1)))
    else if (m[2]) nodes.push(h('strong', { key: `${key}-${i}` }, m[2].slice(2, -2)))
    else if (m[3]) nodes.push(h('em', { key: `${key}-${i}` }, m[3].slice(1, -1)))
    else if (m[4]) nodes.push(h('span', { key: `${key}-${i}`, style: { color: ACCENT } }, m[6] || m[5]))
    else if (m[7]) nodes.push(h('a', { key: `${key}-${i}`, href: m[9], target: '_blank', rel: 'noopener noreferrer', style: { color: ACCENT } }, m[8]))
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function Preview({ content, onToggleCheckbox }) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '')
  const lines = body.split('\n')
  const out = []
  let inCode = false
  let codeBuf = []
  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(h('pre', { key: idx, style: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '10px', fontSize: '12px', overflowX: 'auto', fontFamily: FONT_MONO } }, codeBuf.join('\n')))
        codeBuf = []
      }
      inCode = !inCode
      return
    }
    if (inCode) { codeBuf.push(line); return }
    const task = /^(\s*)- \[( |x)\] (.*)$/.exec(line)
    if (task) {
      out.push(h('div', { key: idx, style: { display: 'flex', gap: '6px', alignItems: 'baseline', marginLeft: task[1].length * 8 } },
        h('input', { type: 'checkbox', checked: task[2] === 'x', onChange: () => onToggleCheckbox(idx), style: { accentColor: ACCENT } }),
        h('span', { style: task[2] === 'x' ? { color: 'var(--muted)', textDecoration: 'line-through' } : null }, inline(task[3], idx))))
      return
    }
    const head = /^(#{1,4}) (.*)$/.exec(line)
    if (head) { out.push(h(`h${head[1].length}`, { key: idx, style: { margin: '10px 0 4px' } }, inline(head[2], idx))); return }
    const li = /^(\s*)[-*] (.*)$/.exec(line)
    if (li) { out.push(h('div', { key: idx, style: { marginLeft: li[1].length * 8 + 4 } }, '• ', inline(li[2], idx))); return }
    const ol = /^(\s*)(\d+)\. (.*)$/.exec(line)
    if (ol) { out.push(h('div', { key: idx, style: { marginLeft: ol[1].length * 8 + 4 } }, `${ol[2]}. `, inline(ol[3], idx))); return }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push(h('hr', { key: idx, style: { border: 'none', borderTop: '1px solid var(--border)' } })); return }
    if (line.startsWith('> ')) { out.push(h('div', { key: idx, style: { borderLeft: `3px solid ${ACCENT_BG}`, paddingLeft: '8px', color: 'var(--muted)' } }, inline(line.slice(2), idx))); return }
    out.push(line.trim() === '' ? h('div', { key: idx, style: { height: '8px' } }) : h('div', { key: idx }, inline(line, idx)))
  })
  return h('div', { style: { fontSize: '13px', lineHeight: 1.55 } }, out)
}

// ---------- left panel ----------

function badgeStyle(status) {
  const map = {
    pending: { background: 'var(--warn-subtle)', color: 'var(--warn)' },
    conflict: { background: 'var(--danger-subtle)', color: 'var(--danger)' },
    synced: { background: 'var(--card)', color: 'var(--muted)' },
  }
  return { ...map[status], padding: '1px 6px', borderRadius: '9999px', fontSize: '9px', fontWeight: 600 }
}

function NoteRow({ note, active, onOpen }) {
  const [hover, setHover] = useState(false)
  return h('div', {
    onClick: () => onOpen(note.path),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      padding: '5px 8px', borderRadius: '6px', cursor: 'pointer',
      background: active ? ACCENT_BG : hover ? 'var(--card)' : 'transparent',
    },
  },
    h('div', { style: { fontSize: '12px', fontWeight: active ? 600 : 400, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note.title),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '1px' } },
      h('span', { style: { fontSize: '10px', color: 'var(--muted)' } }, relTime(note.modifiedAt)),
      note.syncStatus !== 'synced' && h('span', { style: badgeStyle(note.syncStatus) }, note.syncStatus)))
}

function Folder({ name, node, depth, activePath, onOpen, collapsed, toggle }) {
  const isCollapsed = collapsed.has(name)
  return h(Fragment, null,
    h('div', {
      onClick: () => toggle(name),
      style: { display: 'flex', gap: '4px', alignItems: 'center', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: 'var(--muted)', marginLeft: depth * 10 },
    }, h('span', { style: { fontSize: '9px' } }, isCollapsed ? '▶' : '▼'), name.split('/').pop()),
    !isCollapsed && h('div', { style: { marginLeft: depth * 10 + 8 } }, renderTree(node, depth + 1, name, activePath, onOpen, collapsed, toggle)))
}

function renderTree(node, depth, prefix, activePath, onOpen, collapsed, toggle) {
  const items = []
  for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
    const full = prefix ? `${prefix}/${name}` : name
    items.push(h(Folder, { key: full, name: full, node: child, depth, activePath, onOpen, collapsed, toggle }))
  }
  for (const n of [...node.notes].sort((a, b) => a.title.localeCompare(b.title))) {
    items.push(h(NoteRow, { key: n.path, note: n, active: n.path === activePath, onOpen }))
  }
  return items
}

// ---------- main app ----------

export default function MdNotebook() {
  const [vaults, setVaults] = useState(null)
  const [notes, setNotes] = useState([])
  const [activePath, setActivePath] = useState(null)
  const [content, setContent] = useState('')
  const [backlinks, setBacklinks] = useState([])
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [collapsed, setCollapsed] = useState(new Set())
  const [syncing, setSyncing] = useState(false)
  const [conflicts, setConflicts] = useState([])
  const [error, setError] = useState(null)
  const [ac, setAc] = useState(null) // {items, start} wikilink autocomplete
  // View mode: 'rendered' (default) or 'raw'. Persisted across visits.
  const [mode, setMode] = useState(() => localStorage.getItem('mdnb-view-mode') || 'rendered')
  const switchMode = useCallback((m) => { setMode(m); localStorage.setItem('mdnb-view-mode', m) }, [])
  // Notes panel width, drag-resizable like the Sessions panel. Persisted.
  const [panelW, setPanelW] = useState(() => {
    const w = Number(localStorage.getItem('mdnb-panel-width'))
    return w >= 180 && w <= 420 ? w : 248
  })
  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelW
    const onMove = (ev) => {
      const w = Math.min(420, Math.max(180, startW + (ev.clientX - startX)))
      setPanelW(w)
    }
    const onUp = (ev) => {
      const w = Math.min(420, Math.max(180, startW + (ev.clientX - startX)))
      localStorage.setItem('mdnb-panel-width', String(w))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [panelW])
  const saveTimer = useRef(null)
  const contentRef = useRef('')
  const pathRef = useRef(null)
  const taRef = useRef(null)

  const loadNotes = useCallback(async () => {
    try { setNotes((await api('GET', '/notes')).notes) } catch (e) { setError(String(e.message)) }
  }, [])

  useEffect(() => {
    let cancelled = false
    // The backend takes a few seconds to boot after install/enable — retry
    // with backoff before declaring failure.
    async function loadVaults(attempt = 0) {
      try {
        const v = await api('GET', '/vaults')
        if (cancelled) return
        setError(null); setVaults(v.vaults)
        if (v.vaults.length) loadNotes()
      } catch (e) {
        if (cancelled) return
        if (attempt < 5) setTimeout(() => loadVaults(attempt + 1), 1500 * (attempt + 1))
        else setError(String(e.message))
      }
    }
    loadVaults()
    return () => { cancelled = true }
  }, [loadNotes])

  const flushSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (pathRef.current != null) {
      await api('PUT', '/note', { path: pathRef.current, content: contentRef.current }).catch((e) => setError(String(e.message)))
      setDirty(false)
    }
  }, [])

  const openNote = useCallback(async (path) => {
    if (dirty) await flushSave()
    const data = await api('GET', `/note?path=${encodeURIComponent(path)}`)
    setActivePath(path); pathRef.current = path
    localStorage.setItem('mdnb-open-note', path)
    setContent(data.content); contentRef.current = data.content
    setBacklinks(data.backlinks); setDirty(false); setAc(null)
    loadNotes()
  }, [dirty, flushSave, loadNotes])

  // Restore the last-open note when returning to the app page.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || activePath || !notes.length) return
    restoredRef.current = true
    const saved = localStorage.getItem('mdnb-open-note')
    if (saved && notes.some((n) => n.path === saved)) openNote(saved).catch(() => {})
  }, [notes, activePath, openNote])

  const edit = useCallback((next, cursor) => {
    setContent(next); contentRef.current = next; setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => { await flushSave(); loadNotes() }, 1000)
    // [[ autocomplete: look for an unclosed [[ right before the cursor
    const upto = next.slice(0, cursor)
    const m = /\[\[([^\][\n]*)$/.exec(upto)
    if (m) {
      const q = m[1].toLowerCase()
      const items = notes.filter((n) => n.title.toLowerCase().includes(q) && n.path !== pathRef.current).slice(0, 8)
      setAc(items.length ? { items, start: cursor - m[1].length } : null)
    } else setAc(null)
  }, [flushSave, loadNotes, notes])

  const insertLink = useCallback((title) => {
    const ta = taRef.current
    const cur = contentRef.current
    const cursor = ta.selectionStart
    const next = cur.slice(0, ac.start) + title + ']] ' + cur.slice(cursor)
    edit(next, ac.start + title.length + 3)
    setAc(null); ta.focus()
  }, [ac, edit])

  const toggleCheckbox = useCallback((lineIdx) => {
    const fmMatch = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(contentRef.current)
    const offset = fmMatch ? fmMatch[0].split('\n').length - 1 : 0
    const lines = contentRef.current.split('\n')
    const i = lineIdx + offset
    lines[i] = lines[i].includes('- [ ]') ? lines[i].replace('- [ ]', '- [x]') : lines[i].replace('- [x]', '- [ ]')
    edit(lines.join('\n'), taRef.current?.selectionStart ?? 0)
  }, [edit])

  const runSync = useCallback(async () => {
    setSyncing(true); setError(null)
    try {
      await flushSave()
      const { result } = await api('POST', '/sync')
      setConflicts(result.conflicts)
      await loadNotes()
      if (pathRef.current) openNote(pathRef.current)
    } catch (e) { setError(String(e.message)) } finally { setSyncing(false) }
  }, [flushSave, loadNotes, openNote])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(() => {
      api('GET', `/search?q=${encodeURIComponent(query)}`).then((r) => setResults(r.results)).catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  const tree = useMemo(() => buildTree(notes), [notes])
  const toggle = useCallback((name) => setCollapsed((prev) => {
    const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next
  }), [])

  if (vaults === null) return h('div', { style: { padding: '24px', fontSize: '12px', fontFamily: FONT_BODY, color: error ? 'var(--danger)' : 'var(--muted)' } },
    error ? h(Fragment, null,
      `Could not reach the md-notebook backend: ${error}. It may still be starting — `,
      h('button', { onClick: () => window.location.reload(), style: { background: 'transparent', color: ACCENT, border: `1px solid ${ACCENT_BG}`, padding: '3px 12px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: 'pointer' } }, 'Retry'))
      : 'Loading…')
  if (!vaults.length) return h(ConnectVault, { onConnected: (v) => { setVaults([v]); loadNotes() } })

  const activeNote = notes.find((n) => n.path === activePath)

  return h('div', { style: { display: 'flex', height: '100%', minHeight: '520px', fontFamily: FONT_BODY, color: 'var(--text)', background: 'var(--bg)' } },
    // ---- left panel (Sessions-list chrome: elevated card, header, search) ----
    h('div', { style: { width: `${panelW}px`, flexShrink: 0, display: 'flex', flexDirection: 'column', margin: '8px 0 8px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' } },
      // header row: title + new-note icon button
      h('div', { style: { height: '40px', display: 'flex', alignItems: 'center', padding: '0 8px 0 12px', flexShrink: 0 } },
        h('span', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--text)' } }, 'Notes'),
        h('button', {
          title: 'New note', 'aria-label': 'New note',
          onClick: async () => {
            const name = prompt('New note path (e.g. ideas/My Note.md):')
            if (!name) return
            const path = name.endsWith('.md') ? name : name + '.md'
            await api('PUT', '/note', { path, content: `# ${path.split('/').pop().replace(/\.md$/, '')}\n` })
            await loadNotes(); openNote(path)
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
          style: { marginLeft: 'auto', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'var(--muted)', border: 'none', borderRadius: '8px', cursor: 'pointer' },
        }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }), h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })))),
      // search bar (SearchInput pattern: magnifier + clear X)
      h('div', { style: { padding: '0 8px 4px', flexShrink: 0 } },
        h('div', { style: { position: 'relative' } },
          h('svg', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--muted)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('circle', { cx: 11, cy: 11, r: 8 }), h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
          h('input', {
            value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search notes…',
            style: { width: '100%', boxSizing: 'border-box', fontSize: '13px', padding: '6px 26px 6px 28px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', outline: 'none' },
          }),
          query && h('button', {
            'aria-label': 'Clear search', onClick: () => setQuery(''),
            style: { position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '13px' },
          }, '✕'))),
      h('div', { style: { flex: 1, overflowY: 'auto', padding: '0 6px 8px' } },
        query.trim()
          ? results.length
            ? results.map((r) => h(NoteRow, { key: r.path, note: { path: r.path, title: r.title, modifiedAt: notes.find((n) => n.path === r.path)?.modifiedAt ?? Date.now(), syncStatus: 'synced' }, active: r.path === activePath, onOpen: (p) => { openNote(p) } }))
            : h('div', { style: { padding: '10px', fontSize: '11px', color: 'var(--muted)' } }, 'No matches')
          : renderTree(tree, 0, '', activePath, openNote, collapsed, toggle))),
    // ---- resize handle (drag to resize the notes panel) ----
    h('div', {
      onPointerDown: startResize, role: 'separator', 'aria-label': 'Resize notes panel',
      style: { width: '8px', flexShrink: 0, cursor: 'col-resize', alignSelf: 'stretch' },
    }),
    // ---- main column ----
    h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid var(--border)' } },
        h('span', { style: { fontSize: '15px', fontWeight: 600 } }, activeNote?.title ?? 'MD Notebook'),
        h('span', { style: { background: ACCENT_BG, color: ACCENT, padding: '2px 8px', borderRadius: '9999px', fontSize: '10px', fontWeight: 600 } }, vaults[0].name),
        dirty && h('span', { style: { fontSize: '10px', color: 'var(--muted)' } }, 'saving…'),
        h('span', { style: { marginLeft: 'auto' } }),
        h('div', { style: { display: 'flex', border: '1px solid var(--border)', borderRadius: '9999px', overflow: 'hidden' } },
          ['rendered', 'raw'].map((m) => h('button', {
            key: m, onClick: () => switchMode(m),
            style: {
              background: mode === m ? ACCENT_BG : 'transparent',
              color: mode === m ? ACCENT : 'var(--muted)',
              border: 'none', padding: '4px 12px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
            },
          }, m === 'rendered' ? 'Rendered' : 'Raw'))),
        h('button', {
          onClick: runSync, disabled: syncing,
          style: { background: syncing ? 'transparent' : ACCENT, color: syncing ? 'var(--muted)' : ACCENT_FG, border: 'none', padding: '5px 14px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: syncing ? 'default' : 'pointer' },
        }, syncing ? 'Syncing…' : '↕ Sync')),
      error && h('div', { style: { margin: '8px 14px 0', padding: '6px 12px', borderRadius: '6px', background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: '11px' } }, error),
      conflicts.length > 0 && h('div', { style: { margin: '8px 14px 0', padding: '6px 12px', borderRadius: '6px', background: 'var(--warn-subtle)', color: 'var(--warn)', fontSize: '11px' } },
        `Sync conflicts in: ${conflicts.map((c) => c.path).join(', ')} — local version kept on disk; resolve and sync again.`),
      !activePath
        ? h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: '12px' } }, 'Select a note from the left panel')
        : h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
            mode === 'raw'
              ? h('div', { style: { flex: 1, position: 'relative' } },
                  h('textarea', {
                    ref: taRef, value: content, spellCheck: false,
                    onChange: (e) => edit(e.target.value, e.target.selectionStart),
                    onKeyDown: (e) => { if (e.key === 'Escape') setAc(null) },
                    style: { width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none', border: 'none', outline: 'none', background: 'var(--bg)', color: 'var(--text)', padding: '14px', fontSize: '13px', fontFamily: FONT_MONO, lineHeight: 1.55 },
                  }),
                  ac && h('div', { style: { position: 'absolute', left: '14px', bottom: '14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.25)', overflow: 'hidden', zIndex: 5 } },
                    ac.items.map((n) => h('div', {
                      key: n.path, onClick: () => insertLink(n.title),
                      style: { padding: '5px 12px', fontSize: '12px', cursor: 'pointer', color: 'var(--text)' },
                      onMouseEnter: (e) => { e.currentTarget.style.background = ACCENT_BG },
                      onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
                    }, n.title))))
              : h('div', { style: { flex: 1, overflowY: 'auto', padding: '14px', minWidth: 0 } },
                  h(Preview, { content, onToggleCheckbox: toggleCheckbox }),
                  backlinks.length > 0 && h('div', { style: { marginTop: '18px', borderTop: '1px solid var(--border)', paddingTop: '8px' } },
                    h('div', { style: { fontSize: '11px', fontWeight: 600, color: ACCENT, marginBottom: '4px' } }, `Linked from (${backlinks.length})`),
                    backlinks.map((b, i) => h('div', { key: i, onClick: () => openNote(b.sourcePath), style: { fontSize: '11px', color: 'var(--muted)', cursor: 'pointer', padding: '2px 0' } }, `${b.sourcePath}:${b.line} — ${b.context}`)))))))
}

// ---------- connect vault ----------

function ConnectVault({ onConnected }) {
  const [url, setUrl] = useState('')
  const [pat, setPat] = useState('')
  const [branch, setBranch] = useState('main')
  const [subfolder, setSubfolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [hasGhAuth, setHasGhAuth] = useState(false)
  useEffect(() => {
    api('GET', '/vaults').then((v) => setHasGhAuth(Boolean(v.hasGhAuth))).catch(() => {})
  }, [])
  const field = { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', outline: 'none', marginTop: '4px' }
  const label = { fontSize: '11px', color: 'var(--muted)', display: 'block', marginTop: '12px' }
  return h('div', { style: { maxWidth: '440px', margin: '48px auto', fontFamily: FONT_BODY, color: 'var(--text)' } },
    h('div', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px' } },
      h('div', { style: { fontSize: '18px', fontWeight: 600 } }, 'Connect a vault'),
      h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '4px' } }, 'A GitHub repo (or a subfolder of one) becomes your notes vault. Cloned locally; synced with git.'),
      h('label', { style: label }, 'Repository HTTPS URL', h('input', { style: field, value: url, onChange: (e) => setUrl(e.target.value), placeholder: 'https://github.com/you/notes' })),
      h('label', { style: label },
        hasGhAuth ? 'Personal Access Token (optional — using your Kiro Crew GitHub connection)' : 'Personal Access Token (fine-grained, contents read/write)',
        h('input', { style: field, type: 'password', value: pat, onChange: (e) => setPat(e.target.value), placeholder: hasGhAuth ? 'Leave empty to use GitHub CLI auth' : 'github_pat_…' })),
      h('label', { style: label }, 'Branch', h('input', { style: field, value: branch, onChange: (e) => setBranch(e.target.value) })),
      h('label', { style: label }, 'Subfolder (optional)', h('input', { style: field, value: subfolder, onChange: (e) => setSubfolder(e.target.value), placeholder: 'notes/' })),
      error && h('div', { style: { marginTop: '10px', fontSize: '11px', color: 'var(--danger)' } }, error),
      h('button', {
        disabled: busy || !url,
        onClick: async () => {
          setBusy(true); setError(null)
          try {
            const { vault } = await api('POST', '/vaults', { url, pat: pat || undefined, branch, subfolder: subfolder.replace(/\/$/, '') || undefined })
            onConnected(vault)
          } catch (e) { setError(String(e.message)) } finally { setBusy(false) }
        },
        style: { marginTop: '16px', background: busy ? 'transparent' : ACCENT, color: busy ? 'var(--muted)' : ACCENT_FG, border: 'none', padding: '7px 18px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: busy ? 'default' : 'pointer' },
      }, busy ? 'Cloning…' : 'Connect vault')))
}
