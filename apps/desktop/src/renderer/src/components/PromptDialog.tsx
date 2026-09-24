import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  label: string
  confirmText: string
  initial?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** Minimal modal that collects a single text value (create/rename/delete). */
export function PromptDialog({
  title,
  label,
  confirmText,
  initial = '',
  onSubmit,
  onCancel
}: Props) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 16px 4px', fontWeight: 600 }}>{title}</div>
        <input
          ref={inputRef}
          className="rename"
          placeholder={label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value)
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSubmit(value)} disabled={!value.trim()}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
