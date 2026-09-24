import { useEffect, useState } from 'react'
import { useBrain } from '../store.js'
import { THOUGHT_TYPES, type Attachment, type AttachmentKind, type Thought } from '@the-brain/shared'
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

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [type, setType] = useState('')
  const [attKind, setAttKind] = useState<AttachmentKind>('url')
  const [attUri, setAttUri] = useState('')

  // Re-seed the inline editors whenever focus moves to another thought.
  useEffect(() => {
    setName(focus?.name ?? '')
    setDesc(focus?.description ?? '')
    setType(focus?.type ?? '')
  }, [focus?.id, focus?.type]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !focus) return null

  const commitName = () => {
    const v = name.trim()
    if (v && v !== focus.name) void saveThought({ name: v })
  }
  const commitDesc = () => {
    if (desc !== (focus.description ?? '')) void saveThought({ description: desc })
  }
  const commitType = () => {
    const v = type.trim().toLowerCase()
    if (v !== (focus.type ?? '')) void saveThought({ type: v || null })
  }
  const commitAttachment = async () => {
    if (!attUri.trim()) return
    await addAttachment(attKind, attUri)
    setAttUri('')
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
      </div>

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
          <LinkGroup label="Parents" items={viewport.parents} onJump={focusThought} />
          <LinkGroup label="Children" items={viewport.children} onJump={focusThought} />
          <LinkGroup label="Siblings" items={viewport.siblings} onJump={focusThought} />
          <LinkGroup label="Jumps" items={viewport.jumps} onJump={focusThought} />
        </div>
      )}
    </aside>
  )
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
  onJump
}: {
  label: string
  items: Thought[]
  onJump: (id: string) => Promise<void>
}) {
  if (items.length === 0) return null
  return (
    <section>
      <h4>
        {label} <span className="count">{items.length}</span>
      </h4>
      {items.map((t) => (
        <button key={t.id} className="link-row" onClick={() => void onJump(t.id)}>
          {t.color && <span className="swatch" style={{ background: t.color }} />}
          {t.name}
        </button>
      ))}
    </section>
  )
}
