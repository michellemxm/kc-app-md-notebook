/**
 * Notes (md-notebook) — KiroCrew app UI.
 *
 * Single-note view, NO tabs. The left panel is the only navigation surface:
 * search pinned on top, collapsible folder tree below, session-list-style
 * rows (title + relative time + sync badge). Search swaps the tree for flat
 * ranked results; clearing restores the tree.
 */
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
// The host exposes lucide-react via the app import map; the stub's default
// export proxies the whole module, so any icon is reachable by name.
import lucide from 'lucide-react'

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
  if (!res.ok) {
    // Carry the payload on the error: callers need 409 details (the on-disk
    // content and its fresh mtime) to offer a resolution.
    const err = new Error(json.error || res.statusText)
    err.status = res.status
    err.body = json
    throw err
  }
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

// Sort options for the notes list. Keys are persisted in localStorage, so
// renaming one silently resets the user's choice to the default.
const SORTS = {
  'modified-desc': { label: 'Modified — new to old', cmp: (a, b) => b.modifiedAt - a.modifiedAt },
  'modified-asc': { label: 'Modified — old to new', cmp: (a, b) => a.modifiedAt - b.modifiedAt },
  'created-desc': { label: 'Created — new to old', cmp: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) },
  'created-asc': { label: 'Created — old to new', cmp: (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) },
  'name-asc': { label: 'File name — A to Z', cmp: (a, b) => a.title.localeCompare(b.title) },
  'name-desc': { label: 'File name — Z to A', cmp: (a, b) => b.title.localeCompare(a.title) },
}
const DEFAULT_SORT = 'name-asc'

/**
 * The standard Markdown mark (rounded frame + "M" + down arrow), drawn in
 * lucide's stroke language (2px, round joins) so it sits beside lucide icons.
 * Lucide ships no markdown glyph, hence the hand-built path.
 */
function MarkdownIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 2, y: 5, width: 20, height: 14, rx: 2 }),
    h('path', { d: 'M6 15V9l3 3 3-3v6' }),
    h('path', { d: 'M17 9v6' }),
    h('path', { d: 'm15 13 2 2 2-2' }))
}

/** Short "time since" label for the Sync button ("just now", "5m ago"). */
function agoLabel(ms) {
  const d = Date.now() - ms
  if (d < 45e3) return 'just now'
  const mins = Math.round(d / 60e3)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// ---------- sync preferences ----------

/** Manual-sync shortcut. Cmd+S by default (Ctrl+S on non-Mac keyboards). */
const DEFAULT_SYNC_SHORTCUT = { key: 's', meta: true, ctrl: false, alt: false, shift: false }
const DEFAULT_AUTO_SYNC_MINS = 10

/** Human label in macOS modifier order: Ctrl ⌥ ⇧ ⌘ Key. */
function formatShortcut(sc) {
  if (!sc?.key) return '—'
  const parts = []
  if (sc.ctrl) parts.push('Ctrl')
  if (sc.alt) parts.push('⌥')
  if (sc.shift) parts.push('⇧')
  if (sc.meta) parts.push('⌘')
  parts.push(sc.key.length === 1 ? sc.key.toUpperCase() : sc.key)
  return parts.join(' ')
}

function matchesShortcut(e, sc) {
  if (!sc?.key) return false
  return e.key.toLowerCase() === sc.key.toLowerCase()
    && e.metaKey === !!sc.meta && e.ctrlKey === !!sc.ctrl
    && e.altKey === !!sc.alt && e.shiftKey === !!sc.shift
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
function BlockEditor({ initial, onCommit, onCancel, textStyle }) {
  const [text, setText] = useState(initial)
  const ref = useRef(null)
  // Grow to fit the WRAPPED content. A markdown paragraph is a single logical
  // line, so sizing by newline count would clip it to one visible row and hide
  // the rest; measuring scrollHeight keeps the block at its rendered height.
  const autoSize = useCallback(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    autoSize()
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [autoSize])
  return h('textarea', {
    ref, value: text, spellCheck: false, rows: 1,
    onChange: (e) => { setText(e.target.value); autoSize() },
    onBlur: () => onCommit(text),
    onKeyDown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
    },
    style: {
      width: '100%', boxSizing: 'border-box', resize: 'none', border: `1px solid ${ACCENT_BG}`,
      outline: 'none', background: 'var(--bg-elevated)', color: 'var(--text)', borderRadius: '4px',
      padding: '2px 6px', display: 'block', overflow: 'hidden',
      // Typography defaults to body text so an edited paragraph keeps its
      // rendered look; blocks with their own scale (headings, code) override.
      fontSize: '13px', fontFamily: FONT_BODY, lineHeight: 1.55, ...textStyle,
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
  const blk = (start, end, node, textStyle) => {
    if (editRange && start === editRange.start)
      return h(BlockEditor, {
        key: `edit-${start}`,
        initial: lines.slice(editRange.start, editRange.end + 1).join('\n'),
        onCommit: onCommitEdit, onCancel: onCancelEdit, textStyle,
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
        out.push(blk(codeStart, idx, h('pre', { style: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '10px', fontSize: '12px', overflowX: 'auto', fontFamily: FONT_MONO } }, codeBuf.join('\n')), { fontSize: '12px', fontFamily: FONT_MONO }))
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
      }, inline(head[2], idx)), { fontSize: HSIZE[n - 1], fontWeight: n <= 2 ? 700 : 600, lineHeight: 1.25 }))
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

function NoteRow({ note, active, onOpen, showFolder }) {
  // In plain-list view the folder tree is gone, so surface the note's parent
  // folder in the meta line to disambiguate same-named notes.
  const folder = showFolder && note.path.includes('/') ? note.path.split('/').slice(0, -1).pop() : null
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
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', minWidth: 0 } },
      folder && h('span', {
        title: note.path,
        style: { fontSize: '11px', fontWeight: 400, color: 'var(--muted)', maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 },
      }, folder),
      folder && h('span', { style: { fontSize: '11px', color: 'var(--muted)', flexShrink: 0 } }, '·'),
      h('span', { style: { fontSize: '11px', fontWeight: 400, color: 'var(--muted)', flexShrink: 0 } }, relTime(note.modifiedAt)),
      note.syncStatus !== 'synced' && h('span', { style: badgeStyle(note.syncStatus) }, note.syncStatus)))
}

function Folder({ name, node, depth, activePath, onOpen, collapsed, toggle, cmp }) {
  const isCollapsed = collapsed.has(name)
  // Sessions folder-row recipe: text-[12px] text-muted py-1 gap-2 rounded-md,
  // hover raises text + bg (via .mdnb-row CSS + inherit color).
  return h(Fragment, null,
    h('div', {
      className: 'mdnb-row',
      onClick: () => toggle(name),
      style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 8px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 400, color: 'var(--muted)', marginLeft: depth * 10 },
    }, h('span', {
      // Sessions folder-row recipe: ChevronRight 14px, muted, rotate(0) when
      // collapsed / rotate(90) when open. No transition — their folder rows
      // snap, and a click shouldn't animate.
      style: { display: 'flex', alignItems: 'center', flexShrink: 0, color: 'var(--muted)', transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' },
    }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'm9 18 6-6-6-6' }))), name.split('/').pop(),
      h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--muted)' } }, countNotes(node))),
    !isCollapsed && h('div', { style: { marginLeft: depth * 10 + 8 } }, renderTree(node, depth + 1, name, activePath, onOpen, collapsed, toggle, cmp)))
}

function countNotes(node) {
  let n = node.notes.length
  for (const [, child] of node.folders) n += countNotes(child)
  return n
}

function renderTree(node, depth, prefix, activePath, onOpen, collapsed, toggle, cmp) {
  const items = []
  // Folders stay alphabetical; the sort choice applies to notes within each.
  for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
    const full = prefix ? `${prefix}/${name}` : name
    items.push(h(Folder, { key: full, name: full, node: child, depth, activePath, onOpen, collapsed, toggle, cmp }))
  }
  for (const n of [...node.notes].sort(cmp)) {
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
  // mtime of the open note as last read/written — the save-guard token.
  const mtimeRef = useRef(null)
  // Mirror of `dirty` readable from interval/timer closures.
  const dirtyRef = useRef(false)
  // Set when a save was refused because the file changed on disk underneath.
  const [fileConflict, setFileConflict] = useState(null)
  // Notes changed outside the app since we last looked (from GET /api/changes).
  const [externalChange, setExternalChange] = useState(null)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  // Active vault. All vault-scoped API calls carry ?vault=<id> (the backend's
  // requireVault falls back to the first vault when absent, so this is
  // backward-compatible). Selection persists across visits.
  const [activeVaultId, setActiveVaultId] = useState(() => localStorage.getItem('mdnb-active-vault') || null)
  const vaultRef = useRef(activeVaultId)
  const [vaultSelOpen, setVaultSelOpen] = useState(false)
  // Force the connect/attach screen even when vaults already exist.
  const [showConnect, setShowConnect] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // ---- sync preferences (persisted) ----
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem('mdnb-auto-sync') === '1')
  const [autoSyncMins, setAutoSyncMins] = useState(() => {
    const n = parseInt(localStorage.getItem('mdnb-auto-sync-mins') ?? '', 10)
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_AUTO_SYNC_MINS
  })
  const [syncShortcut, setSyncShortcut] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('mdnb-sync-shortcut') ?? 'null')
      return s?.key ? s : DEFAULT_SYNC_SHORTCUT
    } catch { return DEFAULT_SYNC_SHORTCUT }
  })
  const setAutoSyncPref = useCallback((on) => {
    setAutoSync(on); localStorage.setItem('mdnb-auto-sync', on ? '1' : '0')
  }, [])
  const setAutoSyncMinsPref = useCallback((n) => {
    const v = Math.min(1440, Math.max(1, Math.round(Number(n) || DEFAULT_AUTO_SYNC_MINS)))
    setAutoSyncMins(v); localStorage.setItem('mdnb-auto-sync-mins', String(v))
  }, [])
  const setSyncShortcutPref = useCallback((sc) => {
    setSyncShortcut(sc); localStorage.setItem('mdnb-sync-shortcut', JSON.stringify(sc))
  }, [])
  // True while Settings is capturing a new shortcut — suppresses the global
  // handler so the keys being recorded don't also fire a sync.
  const recordingShortcutRef = useRef(false)
  // Last conflict-free sync for the active vault, persisted per vault so the
  // Sync button still reports accurately after a reload or vault switch.
  const [lastSync, setLastSync] = useState(null)
  // Re-render every 30s so the "5m ago" label ages without user interaction.
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClockTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  // GitHub access status, shown in Settings.
  const [auth, setAuth] = useState({ hasPat: false, hasGhAuth: false })
  // Backend capabilities this UI bundle needs. The gateway keeps an app's
  // backend process alive across UI reloads, so after a backend change the old
  // process can still be serving — detect that and say so plainly.
  const [staleBackend, setStaleBackend] = useState(null)
  useEffect(() => {
    const REQUIRED = ['createdAt', 'attach', 'changes', 'saveGuard', 'forget', 'pat']
    let cancelled = false
    api('GET', '/health').then((h) => {
      if (cancelled) return
      const have = new Set(h?.features ?? [])
      const missing = REQUIRED.filter((f) => !have.has(f))
      setStaleBackend(missing.length ? missing : null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  // Notes-list view ('folder' = custom folder tree, 'list' = flat) and sort
  // order. Both persisted; an unknown stored value falls back to the default.
  const [view, setView] = useState(() => (localStorage.getItem('mdnb-view') === 'list' ? 'list' : 'folder'))
  const [sortKey, setSortKey] = useState(() => {
    const saved = localStorage.getItem('mdnb-sort')
    return saved && SORTS[saved] ? saved : DEFAULT_SORT
  })
  const [sortOpen, setSortOpen] = useState(false)
  const chooseView = useCallback((v) => { setView(v); localStorage.setItem('mdnb-view', v) }, [])
  const chooseSort = useCallback((k) => { setSortKey(k); localStorage.setItem('mdnb-sort', k) }, [])
  // Close the sort menu on outside click or Escape.
  useEffect(() => {
    if (!sortOpen) return
    const onDown = (e) => { if (!e.target.closest?.('.mdnb-sort-menu, .mdnb-sort-btn')) setSortOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setSortOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [sortOpen])
  // Close the vault dropdown on outside click or Escape.
  useEffect(() => {
    if (!vaultSelOpen) return
    const onDown = (e) => { if (!e.target.closest?.('[role="listbox"], .mdnb-vault-trigger')) setVaultSelOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setVaultSelOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [vaultSelOpen])
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
        setAuth({ hasPat: Boolean(v.hasPat), hasGhAuth: Boolean(v.hasGhAuth) })
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
    if (pathRef.current == null) return
    try {
      // baseMtime is the save guard: the backend refuses the write if the file
      // changed on disk since we read it (external edit in another program).
      const r = await api('PUT', vq('/note'), {
        path: pathRef.current, content: contentRef.current, baseMtime: mtimeRef.current ?? undefined,
      })
      if (typeof r.mtime === 'number') mtimeRef.current = r.mtime
      setDirty(false)
    } catch (e) {
      if (e.status === 409 && e.body?.code === 'ESTALE') {
        // Hold the local buffer and let the user choose — never auto-clobber.
        setFileConflict({ path: pathRef.current, disk: e.body.disk ?? '', mtime: e.body.mtime })
      } else setError(String(e.message))
    }
  }, [vq])

  const openNote = useCallback(async (path) => {
    if (dirty) await flushSave()
    const data = await api('GET', vq(`/note?path=${encodeURIComponent(path)}`))
    setActivePath(path); pathRef.current = path
    localStorage.setItem('mdnb-open-note', path)
    setContent(data.content); contentRef.current = data.content
    mtimeRef.current = typeof data.mtime === 'number' ? data.mtime : null
    setBacklinks(data.backlinks); setDirty(false); setAc(null); setEditBlock(null); setFileConflict(null)
    loadNotes()
  }, [dirty, flushSave, loadNotes])

  // Resolve a stale-file conflict. 'mine' re-saves the local buffer against the
  // fresh mtime (overwriting the external edit); 'disk' discards the local
  // buffer and loads what is on disk.
  const resolveConflict = useCallback(async (choice) => {
    const c = fileConflict
    if (!c) return
    setFileConflict(null)
    if (choice === 'disk') {
      setContent(c.disk); contentRef.current = c.disk
      mtimeRef.current = c.mtime ?? null
      setDirty(false); setEditBlock(null)
      return
    }
    mtimeRef.current = c.mtime ?? null
    try {
      const r = await api('PUT', vq('/note'), { path: c.path, content: contentRef.current, baseMtime: mtimeRef.current ?? undefined })
      if (typeof r.mtime === 'number') mtimeRef.current = r.mtime
      setDirty(false)
    } catch (e) { setError(String(e.message)) }
  }, [fileConflict, vq])

  // Poll for changes made outside the app (attached local folders are edited by
  // Obsidian/git too). Cheap loopback GET; the effect stops when unmounted.
  useEffect(() => {
    if (!activeVaultId) return
    let cancelled = false
    let rev = 0
    const tick = async () => {
      try {
        const r = await api('GET', vq(`/changes?since=${rev}`))
        if (cancelled || r.rev === rev) return
        rev = r.rev
        loadNotes()
        const open = pathRef.current
        if (open && r.changed?.includes(open)) {
          if (dirtyRef.current) setExternalChange({ path: open })
          else {
            // No unsaved local edits: silently adopt what's on disk, so the
            // note always shows the latest regardless of where it was edited.
            const data = await api('GET', vq(`/note?path=${encodeURIComponent(open)}`)).catch(() => null)
            if (data && !cancelled) {
              setContent(data.content); contentRef.current = data.content
              mtimeRef.current = typeof data.mtime === 'number' ? data.mtime : null
              setBacklinks(data.backlinks); setEditBlock(null)
              setExternalChange(null)
            }
          }
        }
      } catch { /* backend restarting or watch unsupported — retry next tick */ }
    }
    const id = setInterval(tick, 2500)
    return () => { cancelled = true; clearInterval(id) }
  }, [activeVaultId, vq, loadNotes])

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

  /** Forget a vault (files on disk are never touched by the backend). */
  const forgetVault = useCallback(async (id) => {
    try {
      await api('DELETE', `/vaults?vault=${encodeURIComponent(id)}`)
      const v = await api('GET', '/vaults')
      setVaults(v.vaults)
      setAuth({ hasPat: Boolean(v.hasPat), hasGhAuth: Boolean(v.hasGhAuth) })
      if (id === vaultRef.current) {
        // The active vault went away — fall back to the first remaining one.
        const next = v.vaults[0]
        if (next) switchVault(next.id)
        else {
          vaultRef.current = null; setActiveVaultId(null); localStorage.removeItem('mdnb-active-vault')
          setActivePath(null); pathRef.current = null; setContent(''); contentRef.current = ''
          setNotes([]); setSettingsOpen(false)
        }
      }
    } catch (e) { setError(String(e.message)) }
  }, [switchVault])

  const savePat = useCallback(async (value) => {
    try {
      const r = await api('PUT', '/pat', { pat: value })
      setAuth({ hasPat: Boolean(r.hasPat), hasGhAuth: Boolean(r.hasGhAuth) })
    } catch (e) { setError(String(e.message)) }
  }, [])

  const runSync = useCallback(async () => {
    setSyncing(true); setError(null)
    try {
      await flushSave()
      const { result } = await api('POST', vq('/sync'))
      setConflicts(result.conflicts)
      // Only a conflict-free run counts as "synced" — with conflicts nothing
      // was pushed, so reporting it as a successful sync would be misleading.
      if (!result.conflicts.length && vaultRef.current) {
        const now = Date.now()
        setLastSync(now)
        localStorage.setItem(`mdnb-last-sync-${vaultRef.current}`, String(now))
      }
      await loadNotes()
      if (pathRef.current) openNote(pathRef.current)
    } catch (e) { setError(String(e.message)) } finally { setSyncing(false) }
  }, [flushSave, loadNotes, openNote])

  // Load the stored last-sync time for whichever vault is active.
  useEffect(() => {
    if (!activeVaultId) { setLastSync(null); return }
    const v = parseInt(localStorage.getItem(`mdnb-last-sync-${activeVaultId}`) ?? '', 10)
    setLastSync(Number.isFinite(v) ? v : null)
  }, [activeVaultId])

  // Keep the latest runSync (and guard state) in refs so the timer and the
  // key handler below don't have to be torn down and rebuilt on every render.
  const runSyncRef = useRef(runSync)
  const syncingRef = useRef(false)
  const blockedRef = useRef(false)
  useEffect(() => { runSyncRef.current = runSync }, [runSync])
  useEffect(() => { syncingRef.current = syncing }, [syncing])
  // Don't auto-sync into an unresolved state: a stale-file conflict needs the
  // user's decision, and re-syncing over merge conflicts just repeats itself.
  useEffect(() => { blockedRef.current = Boolean(fileConflict) || conflicts.length > 0 }, [fileConflict, conflicts])

  // Auto sync: the same bidirectional operation as the Sync button (commit
  // local edits -> fetch -> merge -> push), on a timer.
  useEffect(() => {
    if (!autoSync || !activeVaultId) return
    const id = setInterval(() => {
      if (syncingRef.current || blockedRef.current) return
      runSyncRef.current?.()
    }, autoSyncMins * 60_000)
    return () => clearInterval(id)
  }, [autoSync, autoSyncMins, activeVaultId])

  // Manual-sync shortcut. Capture phase + preventDefault so Cmd+S never
  // reaches the browser's "save page" handler.
  useEffect(() => {
    const onKey = (e) => {
      if (recordingShortcutRef.current) return
      if (!matchesShortcut(e, syncShortcut)) return
      e.preventDefault(); e.stopPropagation()
      if (!syncingRef.current) runSyncRef.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [syncShortcut])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }    const t = setTimeout(() => {
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
      `Could not reach the Notes backend: ${error}. It may still be starting — `,
      h('button', { onClick: () => window.location.reload(), style: { background: 'transparent', color: ACCENT, border: `1px solid ${ACCENT_BG}`, padding: '3px 12px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: 'pointer' } }, 'Retry'))
      : 'Loading…')
  if (!vaults.length || showConnect) return h(ConnectVault, {
    onCancel: vaults.length ? () => setShowConnect(false) : null,
    onConnected: (v) => {
      setVaults((prev) => [...prev, v])
      setShowConnect(false)
      switchVault(v.id)
    },
  })

  const activeNote = notes.find((n) => n.path === activePath)

  return h('div', { style: { display: 'flex', height: '100%', minHeight: '520px', position: 'relative', fontFamily: FONT_BODY, color: 'var(--text)', background: 'var(--bg)' } },
    // Row hover mirrors the Sessions list (hover:bg-bg-hover hover:text-text).
    // Active note rows keep their inline accent-subtle background (inline wins).
    settingsOpen && h(SettingsModal, {
      vaults, activeVaultId, hasPat: auth.hasPat, hasGhAuth: auth.hasGhAuth,
      autoSync, autoSyncMins, shortcut: syncShortcut,
      onClose: () => setSettingsOpen(false),
      onSwitchVault: (id) => { switchVault(id); setSettingsOpen(false) },
      onConnect: () => { setSettingsOpen(false); setShowConnect(true) },
      onForget: forgetVault,
      onSetPat: savePat,
      onAutoSync: setAutoSyncPref,
      onAutoSyncMins: setAutoSyncMinsPref,
      onSetShortcut: setSyncShortcutPref,
      onRecordingChange: (on) => { recordingShortcutRef.current = on },
    }),
    h('style', null, '.mdnb-row:hover{background:var(--bg-hover);color:var(--text)}' +
      '.mdnb-search::placeholder{color:color-mix(in srgb,var(--muted) 50%,transparent)}' +
      // Focus state ported verbatim from the dashboard's .focus-ring (index.css),
      // which the Sessions SearchInput uses.
      '.mdnb-search{transition:border-color .2s,box-shadow .2s}' +
      '.mdnb-search:focus{outline:none;border-color:var(--ring);' +
      'box-shadow:0 0 0 3px var(--accent-subtle),0 0 20px color-mix(in srgb,var(--accent) 8%,transparent)}' +
      '.mdnb-vault-trigger:hover{background:var(--bg-hover)}.mdnb-vault-trigger:hover span{color:var(--text)}' +
      // Syncing indicator: three dots fading in sequence.
      '@keyframes mdnb-dot{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
      '.mdnb-dots span{animation:mdnb-dot 1.4s ease-in-out infinite}' +
      '.mdnb-dots span:nth-child(2){animation-delay:.2s}' +
      '.mdnb-dots span:nth-child(3){animation-delay:.4s}' +
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
      // header row (Sessions header recipe: mt-2 h-10 pl-2 pr-3.5; 32px inset
      // clears the floating collapse toggle). Title is the vault selector:
      // vault name + down chevron; dropdown lists connected vaults.
      h('div', { style: { height: '40px', marginTop: '8px', display: 'flex', alignItems: 'center', padding: '0 14px 0 8px', flexShrink: 0, position: 'relative' } },
        h('button', {
          onClick: () => setVaultSelOpen((o) => !o), 'aria-expanded': vaultSelOpen, 'aria-label': 'Switch vault', 'aria-haspopup': 'listbox',
          className: 'mdnb-vault-trigger',
          style: { display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '32px', minWidth: 0, background: 'transparent', border: 'none', padding: '4px 6px', borderRadius: '8px', cursor: 'pointer', fontFamily: FONT_BODY },
        },
          h('span', { style: { fontSize: '14px', fontWeight: 500, color: 'var(--muted)', letterSpacing: '.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            vaults.find((v) => v.id === activeVaultId)?.name ?? 'Notes'),
          h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--muted)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0, transform: vaultSelOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' } },
            h('path', { d: 'm6 9 6 6 6-6' }))),
        // dropdown: elevated card below the header; up to 4 rows then scroll
        vaultSelOpen && h('div', {
          role: 'listbox', 'aria-label': 'Vaults',
          style: { position: 'absolute', top: '38px', left: '38px', minWidth: '180px', maxWidth: 'calc(100% - 46px)', maxHeight: '112px', overflowY: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 4px 14px rgba(0,0,0,0.25)', padding: '4px', zIndex: 20 },
        },
          vaults.map((v) => h('div', {
            key: v.id, className: 'mdnb-row', role: 'option', 'aria-selected': v.id === activeVaultId,
            onClick: () => switchVault(v.id),
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', color: v.id === activeVaultId ? 'var(--text)' : 'var(--muted)' },
          },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v.name),
            v.id === activeVaultId && h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } },
              h('path', { d: 'M20 6 9 17l-5-5' })))),
          // Entry point for adding another vault (clone or attach a folder).
          h('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }),
          h('div', {
            className: 'mdnb-row', role: 'option', 'aria-selected': false,
            onClick: () => { setVaultSelOpen(false); setShowConnect(true) },
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text)' },
          },
            h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', style: { flexShrink: 0 } },
              h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }), h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })),
            'Connect a vault…')),
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
          style: { marginLeft: 'auto', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'var(--muted)', border: 'none', borderRadius: '8px', cursor: 'pointer', flexShrink: 0 },
        }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }), h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })))),
      // search row (SearchInput pattern: magnifier + clear X; wrapper px-2 pt-2
      // pb-1) with a square sort/view button outside the search container.
      h('div', { style: { padding: '8px 8px 4px', flexShrink: 0, display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
          h('svg', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--muted)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('circle', { cx: 11, cy: 11, r: 8 }), h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
          h('input', {
            value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search notes…', className: 'mdnb-search',
            style: { width: '100%', height: '30px', boxSizing: 'border-box', fontSize: '13px', fontFamily: FONT_BODY, padding: `6px ${query ? '26px' : '12px'} 6px 28px`, borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', outline: 'none' },
          }),
          query && h('button', {
            'aria-label': 'Clear search', onClick: () => setQuery(''),
            style: { position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '13px' },
          }, '✕')),
        // ---- sort / view button: square, same 30px height as the search bar ----
        h('div', { style: { position: 'relative', flexShrink: 0 } },
          h('button', {
            className: 'mdnb-sort-btn', onClick: () => setSortOpen((o) => !o),
            title: 'Sort and view', 'aria-label': 'Sort and view notes', 'aria-expanded': sortOpen, 'aria-haspopup': 'menu',
            style: { width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', borderRadius: '8px', border: '1px solid var(--border)', background: sortOpen ? 'var(--bg-hover)' : 'var(--bg-elevated)', color: sortOpen ? 'var(--text)' : 'var(--muted)', cursor: 'pointer', transition: 'color .15s, background .15s' },
          }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M3 6h18' }), h('path', { d: 'M7 12h10' }), h('path', { d: 'M10 18h4' }))),
          sortOpen && h('div', {
            className: 'mdnb-sort-menu', role: 'menu',
            style: { position: 'absolute', top: '34px', right: 0, minWidth: '196px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 4px 14px rgba(0,0,0,0.25)', padding: '4px', zIndex: 20 },
          },
            // Sessions dropdown recipe: text-[11px] uppercase tracking-[.04em]
            // section labels, items with a flex-1 label + accent Check.
            h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', padding: '5px 8px 3px' } }, 'View'),
            [['folder', 'Folders'], ['list', 'Plain list']].map(([v, label]) => h('div', {
              key: v, className: 'mdnb-row', role: 'menuitemradio', 'aria-checked': view === v,
              onClick: () => { chooseView(v); setSortOpen(false) },
              style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text)' },
            },
              h('span', { style: { flex: 1 } }, label),
              view === v && h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } },
                h('path', { d: 'M20 6 9 17l-5-5' })))),
            h('div', { style: { height: '1px', background: 'var(--border)', margin: '4px 0' } }),
            h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', padding: '5px 8px 3px' } }, 'Sort by'),
            Object.entries(SORTS).map(([k, { label }]) => h('div', {
              key: k, className: 'mdnb-row', role: 'menuitemradio', 'aria-checked': sortKey === k,
              onClick: () => { chooseSort(k); setSortOpen(false) },
              style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text)' },
            },
              h('span', { style: { flex: 1, whiteSpace: 'nowrap' } }, label),
              sortKey === k && h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } },
                h('path', { d: 'M20 6 9 17l-5-5' }))))))),
      h('div', { style: { flex: 1, overflowY: 'auto', padding: '8px' } },
        query.trim()
          ? results.length
            ? results.map((r) => h(NoteRow, { key: r.path, note: { path: r.path, title: r.title, modifiedAt: notes.find((n) => n.path === r.path)?.modifiedAt ?? Date.now(), syncStatus: 'synced' }, active: r.path === activePath, onOpen: (p) => { openNote(p) } }))
            : h('div', { style: { padding: '10px', fontSize: '11px', color: 'var(--muted)' } }, 'No matches')
          : view === 'list'
            // Plain list: every note flat, ordered purely by the sort choice.
            ? [...notes].sort(SORTS[sortKey].cmp).map((n) => h(NoteRow, { key: n.path, note: n, active: n.path === activePath, onOpen: openNote, showFolder: true }))
            : renderTree(tree, 0, '', activePath, openNote, collapsed, toggle, SORTS[sortKey].cmp)),
      // ---- bottom-fixed Settings bar (Contact Us recipe, same layout and
      // dimensions as the old vault selector row): label left, gear right ----
      h('div', { style: { flexShrink: 0, marginTop: '4px' } },
        h('div', {
          className: 'mdnb-row',
          onClick: () => setSettingsOpen(true), role: 'button', 'aria-label': 'Open settings',
          style: { display: 'flex', alignItems: 'center', gap: '4px', borderTop: '1px solid var(--border-strong)', padding: '10px 4px 2px 12px', whiteSpace: 'nowrap', marginBottom: '8px', cursor: 'pointer' } },
          h('span', { style: { fontSize: '13px', color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, 'Settings'),
          // settings ingress (stub — wired later)
          h('button', {
            title: 'Settings', 'aria-label': 'Settings',
            onClick: (e) => { e.stopPropagation(); setSettingsOpen(true) },
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
        h('span', { style: { fontSize: '15px', fontWeight: 600 } }, activeNote?.title ?? 'Notes'),
        h('span', { style: { background: ACCENT_BG, color: ACCENT, padding: '2px 8px', borderRadius: '9999px', fontSize: '10px', fontWeight: 600 } }, (vaults.find((v) => v.id === activeVaultId) ?? vaults[0]).name),
        dirty && h('span', { style: { fontSize: '10px', color: 'var(--muted)' } }, 'saving…'),
        h('span', { style: { marginLeft: 'auto' } }),
        h('div', { style: { display: 'flex', border: '1px solid var(--border)', borderRadius: '9999px', overflow: 'hidden' } },
          [['rendered', 'Rendered view'], ['raw', 'Raw markdown']].map(([m, label]) => h('button', {
            key: m, onClick: () => switchMode(m),
            // Icon-only, so the label lives in title + aria-label.
            title: label, 'aria-label': label, 'aria-pressed': mode === m,
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: mode === m ? ACCENT_BG : 'transparent',
              color: mode === m ? ACCENT : 'var(--muted)',
              border: 'none', padding: '4px 12px', cursor: 'pointer',
            },
          }, m === 'rendered' ? h(lucide.FileText, { size: 14 }) : h(MarkdownIcon, { size: 14 })))),
        h('button', {
          onClick: runSync, disabled: syncing,
          title: syncing ? 'Syncing…' : lastSync ? `Last synced ${new Date(lastSync).toLocaleString()} — click to sync now` : 'Never synced — click to sync now',
          // minWidth keeps the header from shifting as the label changes
          // between "Syncing…", "just now" and "12m ago".
          style: { minWidth: '86px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: syncing ? 'transparent' : ACCENT, color: syncing ? 'var(--muted)' : ACCENT_FG, border: 'none', padding: '5px 14px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: syncing ? 'default' : 'pointer' },
        },
          h(lucide.RefreshCw, { size: 12, style: { flexShrink: 0 } }),
          syncing
            ? h('span', null, 'Syncing', h('span', { className: 'mdnb-dots', 'aria-hidden': true },
                h('span', null, '.'), h('span', null, '.'), h('span', null, '.')))
            : h('span', null, lastSync ? agoLabel(lastSync) : 'Sync'))),
      staleBackend && h('div', { style: { margin: '8px 14px 0', padding: '6px 12px', borderRadius: '6px', background: 'var(--warn-subtle)', color: 'var(--warn)', fontSize: '11px' } },
        `The Notes backend is running older code, so some features are unavailable (${staleBackend.join(', ')}). Toggle Notes off and on in the Apps page to restart it.`),
      error && h('div', { style: { margin: '8px 14px 0', padding: '6px 12px', borderRadius: '6px', background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: '11px' } }, error),
      // Save refused: the file changed on disk while it was open here.
      fileConflict && h('div', { style: { margin: '8px 14px 0', padding: '8px 12px', borderRadius: '6px', background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('span', { style: { flex: 1, minWidth: '160px' } }, `“${fileConflict.path}” changed on disk while you were editing it. Nothing was overwritten — choose which version to keep.`),
        h('button', {
          onClick: () => resolveConflict('mine'),
          style: { background: 'var(--danger)', color: 'var(--accent-fg)', border: 'none', padding: '4px 12px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: 'pointer', flexShrink: 0 },
        }, 'Keep my version'),
        h('button', {
          onClick: () => resolveConflict('disk'),
          style: { background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '4px 12px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: 'pointer', flexShrink: 0 },
        }, 'Use the file on disk')),
      // A note changed outside the app; adopted silently unless we had edits.
      // Only surfaced when there ARE unsaved local edits — a clean note just
      // reloads silently, no notice needed.
      externalChange && !fileConflict && h('div', { style: { margin: '8px 14px 0', padding: '6px 12px', borderRadius: '6px', background: 'var(--warn-subtle)', color: 'var(--warn)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '10px' } },
        h('span', { style: { flex: 1 } },
          `“${externalChange.path}” was changed outside the app and you have unsaved edits — saving will ask you to choose.`),
        h('button', {
          onClick: () => setExternalChange(null), 'aria-label': 'Dismiss',
          style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: '11px', flexShrink: 0 },
        }, '✕')),
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

// ---------- settings modal ----------

/**
 * Settings, presented as a floating panel with NO scrim. Portaled to
 * document.body and positioned `fixed`, so it centers on the Kiro Crew window
 * rather than on the app's pane — an in-tree `fixed` element would be trapped
 * by any transformed ancestor in the dashboard layout.
 *
 * With no scrim there is nothing to click "through", so dismissal is explicit:
 * the ✕, Escape, or a click outside the panel.
 */
function SettingsModal({ vaults, activeVaultId, hasPat, hasGhAuth, autoSync, autoSyncMins, shortcut, onClose, onSwitchVault, onConnect, onForget, onSetPat, onAutoSync, onAutoSyncMins, onSetShortcut, onRecordingChange }) {
  const panelRef = useRef(null)
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [confirmForget, setConfirmForget] = useState(null)
  const [recording, setRecording] = useState(false)
  const [shortcutError, setShortcutError] = useState(null)

  // Shortcut capture. Runs in the capture phase so the pressed combination is
  // swallowed here rather than triggering its normal action (or a sync).
  useEffect(() => {
    if (!recording) return
    onRecordingChange?.(true)
    setShortcutError(null)
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRecording(false); return }
      // A lone modifier is the user still assembling the combination.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      // Require a real modifier: a bare key would fire while typing a note.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        setShortcutError('Include ⌘, Ctrl, or ⌥ — a plain key would trigger while typing.')
        return
      }
      onSetShortcut({
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
      })
      setShortcutError(null)
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); onRecordingChange?.(false) }
  }, [recording, onSetShortcut, onRecordingChange])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const onDown = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) onClose() }
    document.addEventListener('keydown', onKey)
    // Defer the outside-click listener so the click that OPENED the modal
    // doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [onClose])

  const sectionLabel = { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: '6px' }
  const field = { boxSizing: 'border-box', fontSize: '12px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', outline: 'none' }
  const pill = (primary) => ({
    background: primary ? ACCENT : 'transparent', color: primary ? ACCENT_FG : 'var(--muted)',
    border: primary ? 'none' : '1px solid var(--border)', padding: '5px 14px', borderRadius: '9999px',
    fontSize: '11px', fontWeight: 500, cursor: busy ? 'default' : 'pointer', flexShrink: 0,
  })

  return createPortal(
    h('div', {
      // Fixed, viewport-centered, pointer-events only on the panel so the rest
      // of the dashboard stays fully interactive (no scrim).
      style: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 1000, fontFamily: FONT_BODY },
    },
      h('div', {
        ref: panelRef, role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Notes settings',
        style: { pointerEvents: 'auto', width: 'min(520px, calc(100vw - 48px))', maxHeight: 'min(640px, calc(100vh - 64px))', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '16px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', color: 'var(--text)', overflow: 'hidden' },
      },
        // header
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 } },
          h('span', { style: { fontSize: '15px', fontWeight: 600, flex: 1 } }, 'Settings'),
          h('button', {
            onClick: onClose, title: 'Close', 'aria-label': 'Close settings',
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)' },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            style: { width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' },
          }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
            h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' })))),
        // body
        h('div', { style: { padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' } },
          // ---- vaults ----
          h('div', null,
            h('div', { style: sectionLabel }, 'Vaults'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              vaults.map((v) => h('div', {
                key: v.id,
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: v.id === activeVaultId ? ACCENT_BG : 'var(--bg)' },
              },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                    h('span', { style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v.name),
                    h('span', { style: { fontSize: '10px', fontWeight: 500, padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--border)', color: 'var(--muted)', flexShrink: 0 } }, v.external ? 'Local folder' : 'Cloned'),
                    v.id === activeVaultId && h('span', { style: { fontSize: '10px', color: ACCENT, flexShrink: 0 } }, 'Active')),
                  h('div', { style: { fontSize: '11px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }, title: v.localPath }, v.localPath),
                  h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '1px' } }, `${v.repo} · ${v.branch}${v.subfolder ? ` · /${v.subfolder}` : ''}`)),
                v.id !== activeVaultId && h('button', { onClick: () => onSwitchVault(v.id), style: pill(false) }, 'Open'),
                h('button', {
                  onClick: () => setConfirmForget(v.id),
                  style: { ...pill(false), color: 'var(--danger)', borderColor: 'var(--danger)' },
                }, 'Remove'))),
              confirmForget && h('div', { style: { padding: '8px 10px', borderRadius: '8px', background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                h('span', { style: { flex: 1, minWidth: '180px' } }, 'Remove this vault from the app? Your files are left untouched on disk — only the connection is forgotten.'),
                h('button', {
                  onClick: async () => { const id = confirmForget; setConfirmForget(null); setBusy(true); await onForget(id); setBusy(false) },
                  style: { ...pill(false), color: 'var(--danger)', borderColor: 'var(--danger)' },
                }, 'Remove it'),
                h('button', { onClick: () => setConfirmForget(null), style: pill(false) }, 'Cancel'))),
            h('button', { onClick: onConnect, style: { ...pill(false), marginTop: '8px' } }, '+ Connect a vault')),
          // ---- github access ----
          h('div', null,
            h('div', { style: sectionLabel }, 'GitHub access'),
            h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginBottom: '8px' } },
              hasPat
                ? 'Using a stored personal access token. It takes precedence over the Kiro Crew GitHub connection.'
                : hasGhAuth
                  ? 'Using your Kiro Crew GitHub connection (your gh CLI login). No token is stored on disk.'
                  : 'No GitHub access configured — clone and sync will fail until you add a token or sign in with the gh CLI.'),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: 'password', value: pat, onChange: (e) => setPat(e.target.value),
                placeholder: hasPat ? 'Replace stored token…' : 'github_pat_…',
                style: { ...field, flex: 1, minWidth: 0 },
              }),
              h('button', {
                disabled: busy || !pat,
                onClick: async () => { setBusy(true); await onSetPat(pat); setPat(''); setNote('Token saved.'); setBusy(false) },
                style: pill(true),
              }, 'Save'),
              hasPat && h('button', {
                disabled: busy,
                onClick: async () => { setBusy(true); await onSetPat(''); setNote('Token cleared.'); setBusy(false) },
                style: pill(false),
              }, 'Clear'))),
          // ---- sync ----
          h('div', null,
            h('div', { style: sectionLabel }, 'Sync'),
            // auto sync toggle
            h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px' } },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13px', fontWeight: 500 } }, 'Auto sync'),
                h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '2px' } },
                  'Pushes your changes to GitHub and pulls the latest, on a timer. Paused while a conflict needs your decision.')),
              h('button', {
                role: 'switch', 'aria-checked': autoSync, 'aria-label': 'Auto sync',
                onClick: () => onAutoSync(!autoSync),
                style: { flexShrink: 0, width: '34px', height: '20px', borderRadius: '9999px', border: 'none', padding: '2px', cursor: 'pointer', background: autoSync ? ACCENT : 'var(--border)', display: 'flex', justifyContent: autoSync ? 'flex-end' : 'flex-start', alignItems: 'center', transition: 'background .15s' },
              }, h('span', { style: { width: '16px', height: '16px', borderRadius: '9999px', background: autoSync ? ACCENT_FG : 'var(--bg-elevated)', display: 'block' } }))),
            // interval — only meaningful once auto sync is on
            autoSync && h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', paddingLeft: '12px', borderLeft: `2px solid ${ACCENT_BG}` } },
              h('span', { style: { fontSize: '12px', color: 'var(--muted)' } }, 'Every'),
              h('input', {
                type: 'number', min: 1, max: 1440, value: autoSyncMins,
                'aria-label': 'Auto sync interval in minutes',
                onChange: (e) => onAutoSyncMins(e.target.value),
                style: { ...field, width: '68px', textAlign: 'center' },
              }),
              h('span', { style: { fontSize: '12px', color: 'var(--muted)' } }, autoSyncMins === 1 ? 'minute' : 'minutes')),
            // manual sync shortcut
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px' } },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13px', fontWeight: 500 } }, 'Manual sync shortcut'),
                h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '2px' } },
                  recording ? 'Press the keys you want to use — Esc to cancel.' : 'Click to record a new shortcut.')),
              h('button', {
                onClick: () => setRecording((r) => !r),
                'aria-label': 'Record manual sync shortcut',
                style: {
                  flexShrink: 0, minWidth: '78px', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer',
                  fontFamily: FONT_MONO, fontSize: '12px',
                  border: `1px solid ${recording ? ACCENT : 'var(--border)'}`,
                  background: recording ? ACCENT_BG : 'var(--bg)',
                  color: recording ? ACCENT : 'var(--text)',
                },
              }, recording ? 'Recording…' : formatShortcut(shortcut)),
              formatShortcut(shortcut) !== formatShortcut(DEFAULT_SYNC_SHORTCUT) && h('button', {
                onClick: () => { setRecording(false); onSetShortcut(DEFAULT_SYNC_SHORTCUT) }, style: pill(false),
              }, 'Reset')),
            shortcutError && h('div', { style: { fontSize: '11px', color: 'var(--danger)', marginTop: '6px' } }, shortcutError)),
          note && h('div', { style: { fontSize: '11px', color: ACCENT } }, note)))),
    document.body,
  )
}



// ---------- connect vault ----------

function ConnectVault({ onConnected, onCancel }) {
  // 'clone' pulls a fresh copy into the app's own storage; 'attach' adopts a
  // checkout you already have on disk (no second copy).
  const [mode, setMode] = useState('clone')
  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')
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
  const attaching = mode === 'attach'
  return h('div', { style: { maxWidth: '440px', margin: '48px auto', fontFamily: FONT_BODY, color: 'var(--text)' } },
    h('div', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px' } },
      h('div', { style: { fontSize: '18px', fontWeight: 600 } }, 'Connect a vault'),
      // mode toggle (segmented pill, same recipe as the Rendered|Raw switch)
      h('div', { style: { display: 'flex', border: '1px solid var(--border)', borderRadius: '9999px', overflow: 'hidden', marginTop: '12px', width: 'fit-content' } },
        [['clone', 'Clone a repo'], ['attach', 'Use a local folder']].map(([m, text]) => h('button', {
          key: m, onClick: () => { setMode(m); setError(null) },
          style: { background: mode === m ? ACCENT_BG : 'transparent', color: mode === m ? ACCENT : 'var(--muted)', border: 'none', padding: '4px 12px', fontSize: '11px', fontWeight: 500, cursor: 'pointer' },
        }, text))),
      h('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '8px' } }, attaching
        ? 'Point at a git checkout you already have. The app edits those files in place — no second copy — and watches for changes made by other programs.'
        : 'A GitHub repo (or a subfolder of one) becomes your notes vault. Cloned locally; synced with git.'),
      attaching
        ? h('label', { style: label }, 'Local folder path', h('input', { style: field, value: folder, onChange: (e) => setFolder(e.target.value), placeholder: '~/Developer/obsidian-personal-notes' }))
        : h(Fragment, null,
            h('label', { style: label }, 'Repository HTTPS URL', h('input', { style: field, value: url, onChange: (e) => setUrl(e.target.value), placeholder: 'https://github.com/you/notes' })),
            h('label', { style: label },
              hasGhAuth ? 'Personal Access Token (optional — using your Kiro Crew GitHub connection)' : 'Personal Access Token (fine-grained, contents read/write)',
              h('input', { style: field, type: 'password', value: pat, onChange: (e) => setPat(e.target.value), placeholder: hasGhAuth ? 'Leave empty to use GitHub CLI auth' : 'github_pat_…' })),
            h('label', { style: label }, 'Branch', h('input', { style: field, value: branch, onChange: (e) => setBranch(e.target.value) }))),
      h('label', { style: label }, 'Subfolder (optional)', h('input', { style: field, value: subfolder, onChange: (e) => setSubfolder(e.target.value), placeholder: 'notes/' })),
      error && h('div', { style: { marginTop: '10px', fontSize: '11px', color: 'var(--danger)' } }, error),
      h('button', {
        disabled: busy || (attaching ? !folder : !url),
        onClick: async () => {
          setBusy(true); setError(null)
          try {
            const sub = subfolder.replace(/\/$/, '') || undefined
            const { vault } = attaching
              ? await api('POST', '/vaults/attach', { path: folder.trim(), subfolder: sub })
              : await api('POST', '/vaults', { url, pat: pat || undefined, branch, subfolder: sub })
            onConnected(vault)
          } catch (e) { setError(String(e.message)) } finally { setBusy(false) }
        },
        style: { marginTop: '16px', background: busy ? 'transparent' : ACCENT, color: busy ? 'var(--muted)' : ACCENT_FG, border: 'none', padding: '7px 18px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: busy ? 'default' : 'pointer' },
      }, busy ? (attaching ? 'Attaching…' : 'Cloning…') : (attaching ? 'Attach folder' : 'Connect vault')),
      onCancel && h('button', {
        onClick: onCancel, disabled: busy,
        style: { marginTop: '16px', marginLeft: '8px', background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', padding: '7px 18px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500, cursor: busy ? 'default' : 'pointer' },
      }, 'Cancel')))
}
