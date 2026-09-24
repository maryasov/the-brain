import { useState, type FormEvent } from 'react'
import { useBrain } from '../store.js'
import { THOUGHT_TYPES, type SetDef } from '@the-brain/shared'
import { typeIcon } from '../typeIcons.js'

/** Trim blanks; unknown/empty fields become an empty (disabled) filter. */
function cleanDef(def: SetDef): SetDef {
  const out: SetDef = {}
  if (def.text?.trim()) out.text = def.text.trim()
  if (def.type?.trim()) out.type = def.type.trim().toLowerCase()
  if (def.tag?.trim()) out.tag = def.tag.trim()
  return out
}

function defSummary(def: SetDef): string {
  const parts: string[] = []
  if (def.text) parts.push(`"${def.text}"`)
  if (def.type) parts.push(`${typeIcon(def.type)} ${def.type}`)
  if (def.tag) parts.push(`#${def.tag}`)
  return parts.join(' · ') || 'all thoughts'
}

/**
 * Right dock: filtered sets — saved searches (text / type / tag) over the
 * whole brain. Running one lists its hits here; clicking a hit focuses it.
 */
export function Sets() {
  const open = useBrain((s) => s.setsOpen)
  const toggle = useBrain((s) => s.toggleSets)
  const sets = useBrain((s) => s.sets)
  const activeSetId = useBrain((s) => s.activeSetId)
  const setResults = useBrain((s) => s.setResults)
  const focusId = useBrain((s) => s.focusId)
  const inspectorOpen = useBrain((s) => s.inspectorOpen)

  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [type, setType] = useState('')
  const [tag, setTag] = useState('')

  if (!open) return null

  const active = sets.find((st) => st.id === activeSetId) ?? null

  const saveNew = async (e: FormEvent) => {
    e.preventDefault()
    const st = useBrain.getState()
    const def = cleanDef({ text, type, tag })
    if (!name.trim() || Object.keys(def).length === 0) return
    await st.createSet(name, def)
    // Immediately run the set we just created, and reset the builder.
    const created = useBrain.getState().sets.find((s2) => s2.name === name.trim())
    if (created) await st.runSet(created.id)
    setName('')
    setText('')
    setType('')
    setTag('')
  }

  return (
    <aside className="sets" style={{ right: inspectorOpen ? 330 : 12 }}>
      <header>
        <span className="title">Sets</span>
        <button className="x" title="Close (S)" onClick={toggle}>
          ×
        </button>
      </header>

      {sets.length === 0 && <div className="sets-empty">No saved sets yet.</div>}
      <ul className="set-list">
        {sets.map((st) => (
          <li key={st.id} className={st.id === activeSetId ? 'active' : ''}>
            <button className="row" onClick={() => void useBrain.getState().runSet(st.id)}>
              <span className="name">{st.name}</span>
              <span className="def">{defSummary(st.def)}</span>
            </button>
            <button
              className="tag-x"
              aria-label="Delete set"
              title="Delete set"
              onClick={() => void useBrain.getState().deleteSet(st.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {active && (
        <div className="set-results">
          <h4>
            {active.name} <span className="count">{setResults.length}</span>
          </h4>
          {setResults.map((t) => (
            <button
              key={t.id}
              className={`set-hit${t.id === focusId ? ' current' : ''}`}
              onClick={() => void useBrain.getState().focus(t.id)}
            >
              <span className="r-icon">{typeIcon(t.type) ?? '·'}</span>
              <span className="name">{t.name}</span>
            </button>
          ))}
        </div>
      )}

      <form className="set-new" onSubmit={(e) => void saveNew(e)}>
        <h4>New set</h4>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="Text (any word)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <input
          placeholder="Type"
          list="set-types"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <datalist id="set-types">
          {THOUGHT_TYPES.map((tt) => (
            <option key={tt} value={tt} />
          ))}
        </datalist>
        <input placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!name.trim()}>
          Save & run
        </button>
      </form>
    </aside>
  )
}
