import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '@the-brain/shared'

interface Props {
  onSelect: (id: string) => void
  onClose: () => void
}

/** Cmd/Ctrl+K command palette over the FTS index; debounced, keyboard-driven. */
export function SearchPalette({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setHits([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      const res = await window.brain.search(query)
      if (!cancelled) {
        setHits(res)
        setActive(0)
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(hits.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter' && hits[active]) {
        e.preventDefault()
        onSelect(hits[active].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hits, active, onSelect, onClose])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Search thoughts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="results">
          {hits.length === 0 && (
            <div className="empty">
              {query.trim() ? 'No matches.' : 'Type to search your brain.'}
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={h.id}
              className={`result${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSelect(h.id)}
            >
              <span className="title">{h.name}</span>
              {h.snippet && <span className="sub">{h.snippet}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
