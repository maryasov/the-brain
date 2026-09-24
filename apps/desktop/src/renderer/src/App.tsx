import { useEffect, useState } from 'react'
import { useBrain, type DialogKind } from './store.js'
import { BrainCanvas } from './BrainCanvas.js'
import { PromptDialog } from './components/PromptDialog.js'
import { SearchPalette } from './components/SearchPalette.js'
import { TagBar } from './components/TagBar.js'
import { Inspector } from './components/Inspector.js'
import { Timeline } from './components/Timeline.js'
import { Minimap } from './components/Minimap.js'
import { Sets } from './components/Sets.js'
import { HoverTip } from './components/HoverTip.js'

const PROMPT_META: Record<
  DialogKind,
  { title: string; label: string; initial?: string; confirmText: string }
> = {
  addChild: { title: 'New child thought', label: 'Child name', confirmText: 'Add child' },
  addParent: { title: 'New parent thought', label: 'Parent name', confirmText: 'Add parent' },
  addJump: { title: 'New jump (association)', label: 'Thought name', confirmText: 'Add jump' },
  addSibling: {
    title: 'New sibling thought',
    label: 'Sibling name',
    confirmText: 'Add sibling'
  },
  rename: { title: 'Rename thought', label: 'Name', confirmText: 'Rename' },
  delete: {
    title: 'Delete thought',
    label: 'Type DELETE to confirm',
    confirmText: 'Delete + detach links'
  }
}

export function App() {
  const init = useBrain((s) => s.init)
  const focusName = useBrain((s) => s.viewport?.focus.name ?? '')
  const focusId = useBrain((s) => s.focusId)
  const pinned = useBrain((s) => s.pinned)
  const error = useBrain((s) => s.error)
  const loading = useBrain((s) => s.loading)
  const inspectorOpen = useBrain((s) => s.inspectorOpen)
  const timelineOpen = useBrain((s) => s.timelineOpen)
  const setsOpen = useBrain((s) => s.setsOpen)
  const dialog = useBrain((s) => s.dialog)
  const openDialog = useBrain((s) => s.openDialog)

  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // Global keyboard navigation (ignored while a modal/search has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modalOpen = dialog !== null || searchOpen
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
        return
      }
      if (modalOpen) return
      // Never hijack keys while typing in an inline field (e.g. the tag input).
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const st = useBrain.getState()
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          st.moveSelection('up')
          break
        case 'ArrowDown':
          e.preventDefault()
          st.moveSelection('down')
          break
        case 'ArrowLeft':
          e.preventDefault()
          st.moveSelection('left')
          break
        case 'ArrowRight':
          e.preventDefault()
          st.moveSelection('right')
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          void st.commitSelection()
          break
        case 'Escape':
          void st.back()
          break
        case 'F2':
          e.preventDefault()
          openDialog('rename')
          break
        case 'i':
        case 'I':
          st.toggleInspector()
          break
        case 't':
        case 'T':
          st.toggleTimeline()
          break
        case 's':
        case 'S':
          st.toggleSets()
          break
        case 'Backspace':
          if (e.shiftKey) {
            e.preventDefault()
            void st.back()
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, searchOpen, openDialog])

  const submitPrompt = async (value: string) => {
    const st = useBrain.getState()
    switch (dialog) {
      case 'addChild':
        await st.addChild(value)
        break
      case 'addParent':
        await st.addParent(value)
        break
      case 'addJump':
        await st.addJump(value)
        break
      case 'addSibling':
        await st.addSibling(value)
        break
      case 'rename':
        if (focusId) await st.rename(focusId, value)
        break
      case 'delete':
        if (focusId && value.trim().toUpperCase() === 'DELETE') {
          await st.remove(focusId, 'detach')
        }
        break
    }
    openDialog(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          The Brain
        </div>
        <button
          className="btn"
          onClick={() => void useBrain.getState().back()}
          title="Back (Esc / Shift+Backspace)"
        >
          ‹ Back
        </button>
        <button className="btn" onClick={() => void useBrain.getState().forward()} title="Forward">
          Forward ›
        </button>
        <div className="focus-name" title={focusName}>
          {focusName || '—'}
        </div>
        <div className="spacer" />
        <button className="btn search-btn" onClick={() => setSearchOpen(true)}>
          <span>Search thoughts…</span>
          <span className="kbd">⌘/Ctrl K</span>
        </button>
        <button className="btn" onClick={() => openDialog('rename')} title="Rename (F2)">
          Rename
        </button>
        <button className="btn" onClick={() => focusId && void useBrain.getState().togglePin(focusId, !pinned.some((p) => p.id === focusId))}>
          {focusId && pinned.some((p) => p.id === focusId) ? 'Unpin' : 'Pin'}
        </button>
        <button className="btn" onClick={() => openDialog('delete')}>
          Delete
        </button>
        <button
          className="btn"
          onClick={() => void useBrain.getState().exportBrain()}
          title="Export the whole brain (JSON snapshot or OPML outline) to a file"
        >
          Export
        </button>
        <button
          className="btn"
          onClick={() => void useBrain.getState().importBrain()}
          title="Import a JSON snapshot or OPML outline (merged, nothing is deleted)"
        >
          Import
        </button>
        <button
          className={setsOpen ? 'btn on' : 'btn'}
          onClick={() => useBrain.getState().toggleSets()}
          title="Filtered sets (S)"
        >
          Sets
        </button>
        <button
          className={timelineOpen ? 'btn on' : 'btn'}
          onClick={() => useBrain.getState().toggleTimeline()}
          title="Recent thoughts (T)"
        >
          Recent
        </button>
        <button
          className={inspectorOpen ? 'btn on' : 'btn'}
          onClick={() => useBrain.getState().toggleInspector()}
          title="Thought inspector (I)"
        >
          Info
        </button>
        <button className="btn primary" onClick={() => openDialog('addChild')}>
          + Child
        </button>
        <button className="btn" onClick={() => openDialog('addParent')}>
          + Parent
        </button>
        <button className="btn" onClick={() => openDialog('addJump')}>
          + Jump
        </button>
      </header>

      <div
        className="stage"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // Dropping files from the OS attaches them to the focused thought.
          e.preventDefault()
          const files = Array.from(e.dataTransfer.files)
          if (files.length === 0) return
          const st = useBrain.getState()
          for (const f of files) {
            const path = window.brain.getPathForFile(f)
            if (path) void st.addAttachment('file', path, f.name)
          }
        }}
      >
        <BrainCanvas />

        <div className="pinboard">
          {pinned.map((p) => (
            <button key={p.id} className="pin" onClick={() => void useBrain.getState().focus(p.id)}>
              ★ {p.name}
            </button>
          ))}
        </div>

        <div className="tagwrap">
          <TagBar />
        </div>

        <div className="legend">
          <Legend color="var(--parent)" label="Parents ↑" />
          <Legend color="var(--child)" label="Children ↓" />
          <Legend color="var(--jump)" label="Jumps ←" />
          <Legend color="var(--sibling)" label="Siblings →" />
        </div>

        <div className="hint">
          Arrows move · Enter focuses · Click a node to jump · Hover for a card · Click a gate or
          empty zone to create · Drag between nodes to link (Shift = parent → child)
        </div>

        <Inspector />
        <Timeline />
        <Minimap />
        <Sets />
        <HoverTip />

        {loading && <OverlayMessage text="Loading brain…" />}
        {error && <OverlayMessage text={error} tone="error" />}
      </div>

      {dialog && (
        <PromptDialog
          title={PROMPT_META[dialog].title}
          label={PROMPT_META[dialog].label}
          confirmText={PROMPT_META[dialog].confirmText}
          initial={dialog === 'rename' ? focusName : PROMPT_META[dialog].initial}
          onSubmit={submitPrompt}
          onCancel={() => openDialog(null)}
        />
      )}

      {searchOpen && (
        <SearchPalette
          onSelect={(id) => {
            setSearchOpen(false)
            void useBrain.getState().focus(id)
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="item">
      <span className="swatch" style={{ background: color }} />
      {label}
    </span>
  )
}

function OverlayMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f1218cc',
        color: tone === 'error' ? 'var(--sibling)' : 'var(--muted)',
        fontSize: 14
      }}
    >
      {text}
    </div>
  )
}
