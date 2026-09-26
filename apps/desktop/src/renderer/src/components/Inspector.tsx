import { useEffect, useState } from 'react'
import { useBrain } from '../store.js'
import {
  THOUGHT_TYPES,
  type Attachment,
  type AttachmentKind,
  type BrainEvent,
  type Link,
  type Thought
} from '@the-brain/shared'
import { typeIcon } from '../typeIcons.js'

/**
 * Thought inspector: the content side of TheBrain — edit the focused
 * thought's name / description / color, and jump across every relationship
 * it has (parents, children, siblings, jumps).
 */
export function Inspector() {
  const open = useBrain((s) => s.inspectorOpen)
  const toggle = useBrain((s) => s.toggleInspector)
  const focus = useBrain((s) => s.viewport?.focus ?? null)
  const viewport = useBrain((s) => s.viewport)
  const saveThought = useBrain((s) => s.saveThought)
  const focusThought = useBrain((s) => s.focus)
  const attachments = useBrain((s) => s.attachments)
  const addAttachment = useBrain((s) => s.addAttachment)
  const removeAttachment = useBrain((s) => s.removeAttachment)
  const openAttachment = useBrain((s) => s.openAttachment)
  const history = useBrain((s) => s.history)
  const asOf = useBrain((s) => s.asOf)
  const neighborhood = useBrain((s) => s.neighborhood)
  const reload = useBrain((s) => s.reload)

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [type, setType] = useState('')
  const [attKind, setAttKind] = useState<AttachmentKind>('url')
  const [attUri, setAttUri] = useState('')
  // Inline editor for one link's label/notes (named relationships).
  const [editing, setEditing] = useState<Link | null>(null)
  const [relLabel, setRelLabel] = useState('')
  const [relNotes, setRelNotes] = useState('')

  // Re-seed the inline editors whenever focus moves to another thought.
  useEffect(() => {
    setName(focus?.name ?? '')
    setDesc(focus?.description ?? '')
    setType(focus?.type ?? '')
    setEditing(null)
  }, [focus?.id, focus?.type]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !focus) return null

  // While viewing the past, the inspector is read-only: edits would hit the
  // present and immediately diverge from what the canvas shows.
  const past = asOf !== null
  const commitName = () => {
    if (past) return
    const v = name.trim()
    if (v && v !== focus.name) void saveThought({ name: v })
  }
  const commitDesc = () => {
    if (past) return
    if (desc !== (focus.description ?? '')) void saveThought({ description: desc })
  }
  const commitType = () => {
    if (past) return
    const v = type.trim().toLowerCase()
    if (v !== (focus.type ?? '')) void saveThought({ type: v || null })
  }
  const commitAttachment = async () => {
    if (past || !attUri.trim()) return
    await addAttachment(attKind, attUri)
    setAttUri('')
  }
  const openLinkEditor = (l: Link) => {
    setEditing(l)
    setRelLabel(l.label ?? '')
    setRelNotes(l.notes ?? '')
  }
  const saveLinkInfo = async () => {
    if (!editing) return
    await window.brain.setLinkInfo({
      fromId: editing.fromId,
      toId: editing.toId,
      type: editing.type,
      label: relLabel,
      notes: relNotes
    })
    setEditing(null)
    await reload()
  }

  return (
    <aside className="inspector">
      <header>
        <span className="title">Thought</span>
        <button className="x" title="Close (I)" onClick={toggle}>
          ×
        </button>
      </header>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>

      <div className="field color-row">
        <span>Color</span>
        <input
          type="color"
          value={focus.color ?? '#5aa2ff'}
          onChange={(e) => void saveThought({ color: e.target.value })}
        />
        <button
          className="link-btn"
          disabled={!focus.color}
          onClick={() => void saveThought({ color: null })}
        >
          reset
        </button>
      </div>

      <div className="field color-row">
        <span>Type</span>
        <span className="type-icon" title={focus.type ?? 'no type'}>
          {typeIcon(focus.type) ?? '·'}
        </span>
        <input
          className="type-input"
          list="thought-types"
          placeholder="none"
          value={type}
          onChange={(e) => setType(e.target.value)}
          onBlur={commitType}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <datalist id="thought-types">
          {THOUGHT_TYPES.map((tt) => (
            <option key={tt} value={tt} />
          ))}
        </datalist>
        <button
          className="link-btn"
          disabled={!focus.type}
          onClick={() => void saveThought({ type: null })}
        >
          reset
        </button>
      </div>

      <label className="field grow">
        <span>Description</span>
        <textarea
          value={desc}
          placeholder="What this thought is about…"
          onChange={(e) => setDesc(e.target.value)}
          onBlur={commitDesc}
        />
      </label>

      <div className="meta">
        created {new Date(focus.createdAt).toLocaleDateString()} · updated{' '}
        {new Date(focus.updatedAt).toLocaleDateString()}
        {past && ' · viewing the past (read-only)'}
      </div>

      {history.length > 0 && (
        <section className="history">
          <h4>History</h4>
          {history.map((e) => (
            <div key={e.seq} className="hist-row">
              <span className="what">{eventText(e, focus.id)}</span>
              <span className="when">{new Date(e.at).toLocaleString()}</span>
            </div>
          ))}
        </section>
      )}

      <section className="atts">
        <h4>
          Attachments <span className="count">{attachments.length}</span>
        </h4>
        {attachments.map((a) => (
          <div key={a.id} className="att-row">
            <button className="att-open" onClick={() => void openAttachment(a)} title={a.uri}>
              <span className={`att-kind ${a.kind}`}>{a.kind[0].toUpperCase()}</span>
              <span className="att-name">{a.label ?? shorten(a)}</span>
            </button>
            <button className="tag-x" aria-label="Remove attachment" onClick={() => void removeAttachment(a.id)}>
              ×
            </button>
          </div>
        ))}
        <div className="att-add">
          <select value={attKind} onChange={(e) => setAttKind(e.target.value as AttachmentKind)}>
            <option value="url">url</option>
            <option value="file">file</option>
            <option value="thought">thought</option>
          </select>
          <input
            placeholder={
              attKind === 'url' ? 'https://…' : attKind === 'file' ? '/path/to/file' : 'thought name'
            }
            value={attUri}
            onChange={(e) => setAttUri(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void commitAttachment()}
            onBlur={() => void commitAttachment()}
          />
        </div>
      </section>

      {viewport && (
        <div className="links">
          <LinkGroup
            label="Parents"
            items={viewport.parents}
            onJump={focusThought}
            editingId={editing?.id}
            past={past}
            onEdit={openLinkEditor}
            find={(t) =>
              neighborhood?.links.find((l) => l.type === 'child' && l.fromId === t.id && l.toId === focus.id)
            }
          />
          <LinkGroup
            label="Children"
            items={viewport.children}
            onJump={focusThought}
            editingId={editing?.id}
            past={past}
            onEdit={openLinkEditor}
            find={(t) =>
              neighborhood?.links.find((l) => l.type === 'child' && l.fromId === focus.id && l.toId === t.id)
            }
          />
          <LinkGroup
            label="Siblings"
            items={viewport.siblings}
            onJump={focusThought}
            editingId={editing?.id}
            past={past}
            onEdit={openLinkEditor}
            find={(t) => {
              // Sibling edges hang off the shared parent; prefer a labeled one.
              let fallback: Link | undefined
              for (const p of viewport.parents) {
                const l = neighborhood?.links.find(
                  (x) => x.type === 'child' && x.fromId === p.id && x.toId === t.id
                )
                if (l?.label) return l
                fallback ??= l
              }
              return fallback
            }}
          />
          <LinkGroup
            label="Jumps"
            items={viewport.jumps}
            onJump={focusThought}
            editingId={editing?.id}
            past={past}
            onEdit={openLinkEditor}
            find={(t) =>
              neighborhood?.links.find(
                (l) =>
                  l.type === 'jump' &&
                  ((l.fromId === focus.id && l.toId === t.id) || (l.fromId === t.id && l.toId === focus.id))
              )
            }
          />
          {editing && !past && (
            <div className="rel-editor">
              <h4>
                Relationship · {otherEndName(editing, focus.id, neighborhood?.thoughts ?? [])}
              </h4>
              <input
                autoFocus
                placeholder="label (e.g. causes, funds)"
                value={relLabel}
                onChange={(e) => setRelLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveLinkInfo()}
              />
              <textarea
                rows={2}
                placeholder="notes about this relationship…"
                value={relNotes}
                onChange={(e) => setRelNotes(e.target.value)}
              />
              <div className="rel-actions">
                <button className="link-btn" onClick={() => void saveLinkInfo()}>
                  save
                </button>
                <button className="link-btn" onClick={() => setEditing(null)}>
                  cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

/** Display name of the far end of a link, from the loaded neighborhood. */
function otherEndName(l: Link, focusId: string, thoughts: Thought[]): string {
  const other = l.fromId === focusId ? l.toId : l.fromId
  return thoughts.find((t) => t.id === other)?.name ?? other.slice(0, 8)
}

/** Human-readable journal line for the inspector's history section. */
function eventText(e: BrainEvent, thoughtId: string): string {
  const p = e.payload ?? {}
  switch (e.kind) {
    case 'thought_created':
      return 'created'
    case 'thought_deleted':
      return 'deleted'
    case 'thought_renamed':
      return `renamed to “${p.name ?? '?'}”`
    case 'link_created':
      return `${p.type === 'jump' ? 'jumped to' : 'linked'} ${otherEnd(e, thoughtId)}`
    case 'link_deleted':
      return `unlinked ${otherEnd(e, thoughtId)}`
  }
}

/** The far end of a link event, named from the payload when possible. */
function otherEnd(e: BrainEvent, thoughtId: string): string {
  const p = e.payload ?? {}
  const forward = p.fromId === thoughtId
  return (forward ? p.toName : p.fromName) ?? (forward ? p.toId : p.fromId)?.slice(0, 8) ?? '?'
}

/** Label-less attachments display as a file name, host+path, or short id. */
function shorten(a: Attachment): string {
  if (a.kind === 'file') return a.uri.split('/').pop() ?? a.uri
  if (a.kind === 'url' || a.kind === 'image') {
    try {
      const u = new URL(a.uri)
      return u.host + (u.pathname === '/' ? '' : u.pathname)
    } catch {
      return a.uri
    }
  }
  return a.uri.slice(0, 8) + '…'
}

function LinkGroup({
  label,
  items,
  onJump,
  find,
  onEdit,
  editingId,
  past
}: {
  label: string
  items: Thought[]
  onJump: (id: string) => Promise<void>
  find?: (t: Thought) => Link | undefined
  onEdit?: (l: Link) => void
  editingId?: string
  past?: boolean
}) {
  if (items.length === 0) return null
  return (
    <section>
      <h4>
        {label} <span className="count">{items.length}</span>
      </h4>
      {items.map((t) => {
        const l = find?.(t)
        return (
          <div key={t.id} className="link-row">
            <button className="link-jump" onClick={() => void onJump(t.id)} title={l?.notes ?? undefined}>
              {t.color && <span className="swatch" style={{ background: t.color }} />}
              <span className="link-name">{t.name}</span>
              {l?.label && <span className="rel">{l.label}</span>}
            </button>
            {l && !past && (
              <button
                className={`tag-x rel-edit${editingId === l.id ? ' on' : ''}`}
                aria-label="Edit relationship"
                title="Edit relationship label / notes"
                onClick={() => onEdit?.(l)}
              >
                ✎
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
