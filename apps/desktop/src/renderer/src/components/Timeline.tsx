import { useBrain } from '../store.js'

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString()
}

/** Left dock: the "Quiet Eye" timeline — recently touched thoughts. */
export function Timeline() {
  const open = useBrain((s) => s.timelineOpen)
  const recent = useBrain((s) => s.recent)
  const focusId = useBrain((s) => s.focusId)
  const toggleTimeline = useBrain((s) => s.toggleTimeline)
  if (!open) return null

  return (
    <aside className="timeline">
      <header>
        <span className="title">Recent</span>
        <button className="x" onClick={toggleTimeline} title="Close (T)">
          ×
        </button>
      </header>
      {recent.length === 0 && <div className="timeline-empty">Nothing yet.</div>}
      <ul>
        {recent.map((t) => (
          <li key={t.id}>
            <button
              className={`row${t.id === focusId ? ' current' : ''}`}
              onClick={() => void useBrain.getState().focus(t.id)}
            >
              <span className="dot" style={{ background: t.color ?? 'var(--muted)' }} />
              <span className="name">{t.name}</span>
              <span className="when">{ago(t.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
