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
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  // Today: just the time ("3:45 PM")
  if (d.toDateString() === now.toDateString()) return time
  // Within the past 7 days: weekday + time ("Mon 3:45 PM")
  if (now - d < 7 * 86400e3) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  // Older: date only ("Jul 10"), with year when it isn't this year
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
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

// Frontmatter block at the top of a note. Preview strips it, so preview line
// indices are body-relative; editing helpers re-add the offset (see fmOffset).
const FM_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/

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
    else if (m[7]) nodes.push(h('a', { key: `${key}-${i}`, href: m[9], target: '_blank', rel: 'noopener noreferrer', onClick: (e) => e.stopPropagation(), style: { color: ACCENT } }, m[8]))
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// In-place editor for one block. Auto-sizes to its content; blur or
// Cmd/Ctrl+Enter commits, Escape cancels (reverts the block).
function BlockEditor({ initial, onCommit, onCancel }) {
  const [text, setText] = useState(initial)
  const ref = useRef(null)
  useEffect(() => {
    const ta = ref.current
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
  }, [])
  return h('textarea', {
    ref, value: text, spellCheck: false,
    rows: Math.max(1, text.split('\n').length),
    onChange: (e) => setText(e.target.value),
    onBlur: () => onCommit(text),
    onKeyDown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
    },
    style: {
      width: '100%', boxSizing: 'border-box', resize: 'none', border: `1px solid ${ACCENT_BG}`,
      outline: 'none', background: 'var(--bg-elevated)', color: 'var(--text)', borderRadius: '4px',
      padding: '2px 6px', fontSize: '13px', fontFamily: FONT_MONO, lineHeight: 1.55, display: 'block',
    },
  })
}

function Preview({ content, onToggleCheckbox, editRange, onStartEdit, onCommitEdit, onCancelEdit }) {
  const body = content.replace(FM_RE, '')
  const lines = body.split('\n')
  const out = []
  let inCode = false
  let codeBuf = []
  let codeStart = 0
  // Stop block-edit activation for interactive children (checkboxes, links).
  const shield = (e) => e.stopPropagation()
  // Wrap a rendered block so clicking it swaps in the editor for source
  // lines [start, end]. While editing, the editor replaces the block.
  const blk = (start, end, node) => {
    if (editRange && start === editRange.start)
      return h(BlockEditor, {
        key: `edit-${start}`,
        initial: lines.slice(editRange.start, editRange.end + 1).join('\n'),
        onCommit: onCommitEdit, onCancel: onCancelEdit,
      })
    if (editRange && start > editRange.start && start <= editRange.end) return null
    return h('div', {
      key: start, className: 'mdnb-blk',
      onClick: () => onStartEdit(start, end),
      style: { cursor: 'text', borderRadius: '4px', padding: '0 4px', margin: '0 -4px' },
    }, node)
  }
  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(blk(codeStart, idx, h('pre', { style: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '10px', fontSize: '12px', overflowX: 'auto', fontFamily: FONT_MONO } }, codeBuf.join('\n'))))
        codeBuf = []
      } else codeStart = idx
      inCode = !inCode
      return
    }
    if (inCode) { codeBuf.push(line); return }
    const task = /^(\s*)- \[( |x)\] (.*)$/.exec(line)
    if (task) {
      out.push(blk(idx, idx, h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', marginLeft: task[1].length * 8 } },
        h('input', { type: 'checkbox', checked: task[2] === 'x', onClick: shield, onChange: () => onToggleCheckbox(idx), style: { accentColor: ACCENT } }),
        h('span', { style: task[2] === 'x' ? { color: 'var(--muted)', textDecoration: 'line-through' } : null }, inline(task[3], idx)))))
      return
    }
    const head = /^(#{1,6}) (.*)$/.exec(line)
    if (head) {
      const n = head[1].length
      // Type scale (em-based so it tracks the preview's base size):
      // h1 1.802 / h2 1.602 / h3 1.424 / h4 1.266 / h5 1.125 / h6 1.0
      const HSIZE = ['1.802em', '1.602em', '1.424em', '1.266em', '1.125em', '1em']
      out.push(blk(idx, idx, h(`h${n}`, {
        style: {
          fontSize: HSIZE[n - 1],
          fontWeight: n <= 2 ? 700 : 600,
          lineHeight: 1.25,
          margin: n <= 2 ? '14px 0 6px' : '10px 0 4px',
        },
      }, inline(head[2], idx))))
      return
    }
    const li = /^(\s*)[-*] (.*)$/.exec(line)
    if (li) { out.push(blk(idx, idx, h('div', { style: { marginLeft: li[1].length * 8 + 4 } }, '• ', inline(li[2], idx)))); return }
    const ol = /^(\s*)(\d+)\. (.*)$/.exec(line)
    if (ol) { out.push(blk(idx, idx, h('div', { style: { marginLeft: ol[1].length * 8 + 4 } }, `${ol[2]}. `, inline(ol[3], idx)))); return }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push(blk(idx, idx, h('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', pointerEvents: 'none' } }))); return }
    if (line.startsWith('> ')) { out.push(blk(idx, idx, h('div', { style: { borderLeft: `3px solid ${ACCENT_BG}`, paddingLeft: '8px', color: 'var(--muted)' } }, inline(line.slice(2), idx)))); return }
    out.push(blk(idx, idx, line.trim() === '' ? h('div', { style: { height: '8px' } }) : h('div', null, inline(line, idx))))
  })
  // Trailing click-to-append region: clicking the empty space below the note
  // starts a new block at the end (insertion — editRange with end < start).
  const appendStart = lines.length
  out.push(editRange && editRange.start === appendStart
    ? h(BlockEditor, { key: 'edit-append', initial: '', onCommit: onCommitEdit, onCancel: onCancelEdit })
    : h('div', { key: 'append', onClick: () => onStartEdit(appendStart, appendStart - 1), style: { minHeight: '80px', cursor: 'text' } }))
  return h('div', { style: { fontSize: '13px', lineHeight: 1.55, display: 'flex', flexDirection: 'column', minHeight: '100%' } },
    h('style', null, '.mdnb-blk:hover{background:var(--bg-hover)}'),
    out)
}

// ---------- left panel ----------

function badgeStyle(status) {
  // Sessions-list tag-chip recipe: text-[10px] px-1.5 py-[1px] rounded-[4px]
  // leading-none font-medium border.
  const map = {
    pending: { background: 'var(--warn-subtle)', color: 'var(--warn)', borderColor: 'var(--warn)' },
    conflict: { background: 'var(--danger-subtle)', color: 'var(--danger)', borderColor: 'var(--danger)' },
    synced: { background: 'var(--card)', color: 'var(--muted)', borderColor: 'var(--border)' },
  }
  return { ...map[status], padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 500, lineHeight: 1, border: '1px solid', display: 'inline-flex', alignItems: 'center' }
}

function NoteRow({ note, active, onOpen }) {
  // Session-row recipe: px-4 py-2 rounded-md, title text-[13px] font-semibold
  // leading-snug text-text, meta text-[11px] muted mt-0.5, hover bg-bg-hover
  // (via .mdnb-row CSS), active bg-accent-subtle (inline style wins).
  return h('div', {
    className: 'mdnb-row',
    onClick: () => onOpen(note.path),
    style: {
      padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
      ...(active ? { background: ACCENT_BG } : null),
    },
  },
    h('div', { style: { fontSize: '13px', fontWeight: 600, lineHeight: 1.375, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note.title),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' } },
      h('span', { style: { fontSize: '11px', fontWeight: 400, color: 'var(--muted)' } }, relTime(note.modifiedAt)),
      note.syncStatus !== 'synced' && h('span', { style: badgeStyle(note.syncStatus) }, note.syncStatus)))
}

function Folder({ name, node, depth, activePath, onOpen, collapsed, toggle }) {
  const isCollapsed = collapsed.has(name)
  // Sessions folder-row recipe: text-[12px] text-muted py-1 gap-2 rounded-md,
  // hover raises text + bg (via .mdnb-row CSS + inherit color).
  return h(Fragment, null,
    h('div', {
      className: 'mdnb-row',
      onClick: () => toggle(name),
      style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 8px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 400, color: 'var(--muted)', marginLeft: depth * 10 },
    }, h('span', { style: { fontSize: '9px' } }, isCollapsed ? '▶' : '▼'), name.split('/').pop(),
      h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--muted)' } }, countNotes(node))),
    !isCollapsed && h('div', { style: { marginLeft: depth * 10 + 8 } }, renderTree(node, depth + 1, name, activePath, onOpen, collapsed, toggle)))
}

function countNotes(node) {
  let n = node.notes.length
  for (const [, child] of node.folders) n += countNotes(child)
  return n
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
  // Notes panel collapse (Sessions-panel pattern: floating toggle, panel hides).
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('mdnb-panel-open') !== '0')
  const togglePanel = useCallback(() => setPanelOpen((v) => { localStorage.setItem('mdnb-panel-open', v ? '0' : '1'); return !v }), [])
  const switchMode = useCallback((m) => { setMode(m); setEditBlock(null); localStorage.setItem('mdnb-view-mode', m) }, [])
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

  // Active vault. All vault-scoped API calls carry ?vault=<id> (the backend's
  // requireVault falls back to the first vault when absent, so this is
  // backward-compatible). Selection persists across visits.
  const [activeVaultId, setActiveVaultId] = useState(() => localStorage.getItem('mdnb-active-vault') || null)
  const vaultRef = useRef(activeVaultId)
  const [vaultSelOpen, setVaultSelOpen] = useState(false)
  const vq = useCallback((path) => {
    if (!vaultRef.current) return path
    return path + (path.includes('?') ? '&' : '?') + 'vault=' + encodeURIComponent(vaultRef.current)
  }, [])

  const loadNotes = useCallback(async () => {
    try { setNotes((await api('GET', vq('/notes'))).notes) } catch (e) { setError(String(e.message)) }
  }, [vq])

  useEffect(() => {
    let cancelled = false
    // The backend takes a few seconds to boot after install/enable — retry
    // with backoff before declaring failure.
    async function loadVaults(attempt = 0) {
      try {
        const v = await api('GET', '/vaults')
        if (cancelled) return
        setError(null); setVaults(v.vaults)
        // Validate the persisted vault id against the live list; fall back to
        // the first vault when stale or unset.
        if (v.vaults.length) {
          const saved = localStorage.getItem('mdnb-active-vault')
          const id = v.vaults.some((x) => x.id === saved) ? saved : v.vaults[0].id
          vaultRef.current = id; setActiveVaultId(id)
          loadNotes()
        }
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
      await api('PUT', vq('/note'), { path: pathRef.current, content: contentRef.current }).catch((e) => setError(String(e.message)))
      setDirty(false)
    }
  }, [])

  const openNote = useCallback(async (path) => {
    if (dirty) await flushSave()
    const data = await api('GET', vq(`/note?path=${encodeURIComponent(path)}`))
    setActivePath(path); pathRef.current = path
    localStorage.setItem('mdnb-open-note', path)
    setContent(data.content); contentRef.current = data.content
    setBacklinks(data.backlinks); setDirty(false); setAc(null); setEditBlock(null)
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
    const fmMatch = FM_RE.exec(contentRef.current)
    const offset = fmMatch ? fmMatch[0].split('\n').length - 1 : 0
    const lines = contentRef.current.split('\n')
    const i = lineIdx + offset
    lines[i] = lines[i].includes('- [ ]') ? lines[i].replace('- [ ]', '- [x]') : lines[i].replace('- [x]', '- [ ]')
    edit(lines.join('\n'), taRef.current?.selectionStart ?? 0)
  }, [edit])

  // Block-level editing in rendered view. Ranges are body-relative (Preview
  // strips frontmatter); commit re-adds the offset and splices the source.
  // An insertion (append) is expressed as end < start — splice count 0.
  const [editBlock, setEditBlock] = useState(null)
  const startBlockEdit = useCallback((start, end) => setEditBlock({ start, end }), [])
  const cancelBlockEdit = useCallback(() => setEditBlock(null), [])
  const commitBlockEdit = useCallback((text) => {
    if (editBlock) {
      const fmMatch = FM_RE.exec(contentRef.current)
      const offset = fmMatch ? fmMatch[0].split('\n').length - 1 : 0
      const lines = contentRef.current.split('\n')
      const count = Math.max(0, editBlock.end - editBlock.start + 1)
      const before = lines.slice(editBlock.start + offset, editBlock.start + offset + count).join('\n')
      if (text !== before && !(count === 0 && text.trim() === '')) {
        lines.splice(editBlock.start + offset, count, ...text.split('\n'))
        edit(lines.join('\n'), 0)
      }
    }
    setEditBlock(null)
  }, [editBlock, edit])

  // Switch the active vault: flush any pending save first, reset all
  // note-scoped state, then reload the new vault's tree.
  const switchVault = useCallback(async (id) => {
    setVaultSelOpen(false)
    if (id === vaultRef.current) return
    if (saveTimer.current) await flushSave()
    vaultRef.current = id; setActiveVaultId(id)
    localStorage.setItem('mdnb-active-vault', id)
    setActivePath(null); pathRef.current = null
    setContent(''); contentRef.current = ''
    setBacklinks([]); setDirty(false); setAc(null); setEditBlock(null)
    setQuery(''); setResults([]); setConflicts([]); setError(null)
    loadNotes()
  }, [flushSave, loadNotes])

  const runSync = useCallback(async () => {
    setSyncing(true); setError(null)
    try {
      await flushSave()
      const { result } = await api('POST', vq('/sync'))
      setConflicts(result.conflicts)
      await loadNotes()
      if (pathRef.current) openNote(pathRef.current)
    } catch (e) { setError(String(e.message)) } finally { setSyncing(false) }
  }, [flushSave, loadNotes, openNote])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(() => {
      api('GET', vq(`/search?q=${encodeURIComponent(query)}`)).then((r) => setResults(r.results)).catch(() => {})
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

  return h('div', { style: { display: 'flex', height: '100%', minHeight: '520px', position: 'relative', fontFamily: FONT_BODY, color: 'var(--text)', background: 'var(--bg)' } },
    // Row hover mirrors the Sessions list (hover:bg-bg-hover hover:text-text).
    // Active note rows keep their inline accent-subtle background (inline wins).
    h('style', null, '.mdnb-row:hover{background:var(--bg-hover);color:var(--text)}' +
      '.mdnb-search::placeholder{color:color-mix(in srgb,var(--muted) 50%,transparent)}' +
      '.mdnb-collapse{color:var(--muted)}.mdnb-collapse:hover{color:var(--text)}'),
    // Floating panel toggle (Sessions-panel recipe: 34px square, top-20 left-8,
    // borderless, muted -> text on hover; stays put when the panel hides).
    h('button', {
      className: 'mdnb-collapse', onClick: togglePanel,
      title: panelOpen ? 'Hide notes' : 'Show notes',
      'aria-label': panelOpen ? 'Hide notes panel' : 'Show notes panel',
      style: { position: 'absolute', top: '20px', left: '8px', zIndex: 10, width: '34px', height: '34px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'transparent', border: 'none', transition: 'color .15s' },
    }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }),
      h('path', { d: 'M9 3v18' }),
      h('path', { d: panelOpen ? 'm16 15-3-3 3-3' : 'm14 9 3 3-3 3' }))),
    // ---- left panel (Sessions-list chrome: elevated card, header, search) ----
    // Wrapper spacing matches OverlayDrawer: py-2 only, NO left margin — the
    // panel hugs the content edge exactly like the Sessions panel does.
    panelOpen && h('div', { style: { width: `${panelW}px`, flexShrink: 0, position: 'relative', display: 'flex', flexDirection: 'column', margin: '8px 0', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' } },
      // header row: title + new-note icon button (Sessions header recipe:
      // mt-2 h-10 pl-2 pr-3.5, title text-sm font-medium text-muted tracking-[.04em];
      // 32px title inset clears the floating collapse toggle, like their pl-8)
      h('div', { style: { height: '40px', marginTop: '8px', display: 'flex', alignItems: 'center', padding: '0 14px 0 8px', flexShrink: 0 } },
        h('span', { style: { fontSize: '14px', fontWeight: 500, color: 'var(--muted)', letterSpacing: '.04em', paddingLeft: '32px' } }, 'Notes'),
        h('button', {
          title: 'New note', 'aria-label': 'New note',
          onClick: async () => {
            const name = prompt('New note path (e.g. ideas/My Note.md):')
            if (!name) return
            const path = name.endsWith('.md') ? name : name + '.md'
            await api('PUT', vq('/note'), { path, content: `# ${path.split('/').pop().replace(/\.md$/, '')}\n` })
            await loadNotes(); openNote(path)
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
          style: { marginLeft: 'auto', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'var(--muted)', border: 'none', borderRadius: '8px', cursor: 'pointer' },
        }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }), h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })))),
      // search bar (SearchInput pattern: magnifier + clear X; wrapper px-2 pt-2 pb-1)
      h('div', { style: { padding: '8px 8px 4px', flexShrink: 0 } },
        h('div', { style: { position: 'relative' } },
          h('svg', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--muted)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('circle', { cx: 11, cy: 11, r: 8 }), h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
          h('input', {
            value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search notes…', className: 'mdnb-search',
            style: { width: '100%', boxSizing: 'border-box', fontSize: '13px', fontFamily: FONT_BODY, padding: `6px ${query ? '26px' : '12px'} 6px 28px`, borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', outline: 'none' },
          }),
          query && h('button', {
            'aria-label': 'Clear search', onClick: () => setQuery(''),
            style: { position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '13px' },
          }, '✕'))),
      h('div', { style: { flex: 1, overflowY: 'auto', padding: '8px' } },
        query.trim()
          ? results.length
            ? results.map((r) => h(NoteRow, { key: r.path, note: { path: r.path, title: r.title, modifiedAt: notes.find((n) => n.path === r.path)?.modifiedAt ?? Date.now(), syncStatus: 'synced' }, active: r.path === activePath, onOpen: (p) => { openNote(p) } }))
            : h('div', { style: { padding: '10px', fontSize: '11px', color: 'var(--muted)' } }, 'No matches')
          : renderTree(tree, 0, '', activePath, openNote, collapsed, toggle)),
      // ---- bottom-fixed vault selector (Contact Us recipe: border-t
      // border-strong, pl-3 pr-1 pt-2.5 pb-0.5, 13px muted label, mt-1) ----
      h('div', { style: { flexShrink: 0, marginTop: '4px' } },
        // expanded vault list: up to 4 rows visible, then in-container scroll
        vaultSelOpen && h('div', { style: { maxHeight: '112px', overflowY: 'auto', padding: '4px 8px', borderTop: '1px solid var(--border-strong)' } },
          vaults.map((v) => h('div', {
            key: v.id, className: 'mdnb-row',
            onClick: () => switchVault(v.id),
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', color: v.id === activeVaultId ? 'var(--text)' : 'var(--muted)' },
          },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v.name),
            v.id === activeVaultId && h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } },
              h('path', { d: 'M20 6 9 17l-5-5' }))))),
        // trigger row
        h('div', {
          onClick: () => setVaultSelOpen((o) => !o), role: 'button', 'aria-expanded': vaultSelOpen, 'aria-label': 'Switch vault',
          style: { display: 'flex', alignItems: 'center', gap: '4px', borderTop: '1px solid var(--border-strong)', padding: '10px 4px 2px 12px', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '8px' },
        },
          // disclosure chevron left of the name: right when collapsed, down when open
          h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--muted)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } },
            h('path', { d: vaultSelOpen ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6' })),
          h('span', { style: { fontSize: '13px', color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, vaults.find((v) => v.id === activeVaultId)?.name ?? 'Vault'),
          // settings ingress (Contact Us icon-button treatment; wired later)
          h('button', {
            title: 'Vault settings', 'aria-label': 'Vault settings',
            onClick: (e) => e.stopPropagation(),
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text)' },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)' },
            style: { width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px', color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'color .15s, background .15s' },
          },
            h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }),
              h('circle', { cx: 12, cy: 12, r: 3 }))))),
      // ---- resize handle (Sessions recipe: absolute overlay straddling the
      // panel's right edge — w-[5px] -right-[2px], takes no layout width) ----
      h('div', {
        onPointerDown: startResize, role: 'separator', 'aria-label': 'Resize notes panel',
        style: { position: 'absolute', top: 0, right: '-2px', width: '5px', height: '100%', cursor: 'col-resize', zIndex: 10, touchAction: 'none' },
      })),
    // ---- main column ----
    h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: panelOpen ? '10px 14px' : '10px 14px 10px 48px', borderBottom: '1px solid var(--border)' } },
        h('span', { style: { fontSize: '15px', fontWeight: 600 } }, activeNote?.title ?? 'MD Notebook'),
        h('span', { style: { background: ACCENT_BG, color: ACCENT, padding: '2px 8px', borderRadius: '9999px', fontSize: '10px', fontWeight: 600 } }, (vaults.find((v) => v.id === activeVaultId) ?? vaults[0]).name),
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
              : h('div', { style: { flex: 1, overflowY: 'auto', minWidth: 0 } },
                  // Chat-message column treatment: px-5 (20px), centered,
                  // maxWidth 800px (CONTENT_WIDTH.compact.messages).
                  h('div', { style: { padding: '14px 20px', margin: '0 auto', width: '100%', maxWidth: '800px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: '100%' } },
                  h(Preview, { content, onToggleCheckbox: toggleCheckbox, editRange: editBlock, onStartEdit: startBlockEdit, onCommitEdit: commitBlockEdit, onCancelEdit: cancelBlockEdit }),
                  backlinks.length > 0 && h('div', { style: { marginTop: '18px', borderTop: '1px solid var(--border)', paddingTop: '8px' } },
                    h('div', { style: { fontSize: '11px', fontWeight: 600, color: ACCENT, marginBottom: '4px' } }, `Linked from (${backlinks.length})`),
                    backlinks.map((b, i) => h('div', { key: i, onClick: () => openNote(b.sourcePath), style: { fontSize: '11px', color: 'var(--muted)', cursor: 'pointer', padding: '2px 0' } }, `${b.sourcePath}:${b.line} — ${b.context}`))))))))
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
