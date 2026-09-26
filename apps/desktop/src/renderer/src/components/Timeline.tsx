import { useRef, useState } from 'react'
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
  const asOf = useBrain((s) => s.asOf)
  const earliest = useBrain((s) => s.earliest)
  const setAsOf = useBrain((s) => s.setAsOf)
  const [dragged, setDragged] = useState<number | null>(null)
  const commitTimer = useRef<number | null>(null)
  if (!open) return null

  const now = Date.now()
  const value = dragged ?? asOf ?? now
  const onSlide = (v: number) => {
    setDragged(v)
    if (commitTimer.current !== null) clearTimeout(commitTimer.current)
    commitTimer.current = window.setTimeout(() => {
      setDragged(null)
      void setAsOf(v)
    }, 250)
  }

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

      {earliest !== null && earliest < now - 5000 && (
        <div className="time-machine">
          <h4>Back in time</h4>
          <input
            type="range"
            min={earliest}
            max={now}
            step={Math.max(1, Math.round((now - earliest) / 400))}
            value={value}
            onChange={(e) => onSlide(Number(e.target.value))}
          />
          <div className="tm-when">
            <span>{asOf ? new Date(asOf).toLocaleString() : 'present'}</span>
            {asOf !== null && (
              <button className="link-btn" onClick={() => void setAsOf(null)}>
                now
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
