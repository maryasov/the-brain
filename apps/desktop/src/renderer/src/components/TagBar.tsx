import { useState } from 'react'
import { useBrain } from '../store.js'

/** Tag chips for the focused thought, with inline add/remove. */
export function TagBar() {
  const tags = useBrain((s) => s.tags)
  const addTag = useBrain((s) => s.addTag)
  const removeTag = useBrain((s) => s.removeTag)
  const [draft, setDraft] = useState('')

  const commit = async () => {
    if (!draft.trim()) return
    await addTag(draft)
    setDraft('')
  }

  return (
    <div className="tagbar">
      {tags.map((t) => (
        <span key={t.id} className="tag">
          #{t.name}
          <button
            className="tag-x"
            aria-label={`Remove ${t.name}`}
            onClick={() => void removeTag(t.id)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        list="brain-tags"
        placeholder="+ tag"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
        }}
        onBlur={() => void commit()}
      />
      <datalist id="brain-tags">
        {tags.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  )
}
