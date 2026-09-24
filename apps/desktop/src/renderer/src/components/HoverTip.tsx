import { useBrain } from '../store.js'
import { typeIcon } from '../typeIcons.js'

const TIP_W = 264 // keep in sync with .thought-tip width

/** Relative "updated" label, TheBrain-style: 5m ago / 3h ago / Sep 12. */
function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

/**
 * Hover card for canvas thoughts: name, type, description, tags, and the
 * counts of everything around the thought. Rendered as a fixed overlay so it
 * can float above any panel; positioned (and edge-flipped) from cursor coords.
 */
export function HoverTip() {
  const tip = useBrain((s) => s.hoverTip)
  if (!tip) return null
  const { card, x, y } = tip
  const flipX = x + TIP_W + 24 > window.innerWidth
  const left = flipX ? x - TIP_W - 32 : x
  const top = y + 180 > window.innerHeight ? Math.max(8, y - 160) : y
  return (
    <div className="thought-tip" style={{ left, top }}>
      <div className="tt-title">
        <span className="tt-icon">{typeIcon(card.type) ?? '◉'}</span>
        <span className="tt-name">{card.name}</span>
        {card.pinned && <span className="tt-pin">★</span>}
      </div>
      <div className="tt-meta">
        {card.type ? card.type : 'thought'} · updated {relTime(card.updatedAt)}
      </div>
      {card.description && <div className="tt-desc">{card.description}</div>}
      {card.tags.length > 0 && (
        <div className="tt-tags">
          {card.tags.map((t) => (
            <span key={t} className="tt-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="tt-counts">
        <Count value={card.counts.parents} title="parents" glyph="↑" />
        <Count value={card.counts.children} title="children" glyph="↓" />
        <Count value={card.counts.jumps} title="jumps" glyph="←" />
        <Count value={card.counts.siblings} title="siblings" glyph="→" />
        <Count value={card.attachments} title="attachments" glyph="⧉" />
      </div>
    </div>
  )
}

function Count({ value, title, glyph }: { value: number; title: string; glyph: string }) {
  return (
    <span className={value > 0 ? 'tt-count on' : 'tt-count'} title={title}>
      {glyph}
      {value}
    </span>
  )
}
