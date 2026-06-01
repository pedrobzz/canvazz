import { useEffect, useRef, useState } from 'react'

/**
 * Compact inspector fields. They hold local draft state while focused and
 * commit on Enter/blur, so typing never spams transactions.
 */

export function TextField({
  value,
  onCommit,
  placeholder,
  label,
  mono,
}: {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  label?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      {label ? <span className="w-4 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span> : null}
      <input
        value={draft}
        placeholder={placeholder}
        className={mono ? 'font-mono' : undefined}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false
          if (draft !== value) onCommit(draft)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(value)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </label>
  )
}

export function NumberField({
  value,
  onCommit,
  label,
  step = 1,
  min,
  unit = 'px',
  disabled,
}: {
  /** Current numeric value, or null when mixed/unset. */
  value: number | null
  onCommit: (next: number) => void
  label?: string
  step?: number
  min?: number
  unit?: string
  disabled?: boolean
}) {
  const display = value === null ? '' : String(Math.round(value * 100) / 100)
  const [draft, setDraft] = useState(display)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(display)
  }, [display])

  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) {
      const clamped = min !== undefined ? Math.max(min, n) : n
      if (clamped !== value) onCommit(clamped)
    } else {
      setDraft(display)
    }
  }

  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5" title={unit}>
      {label ? <span className="w-4 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span> : null}
      <input
        value={draft}
        inputMode="decimal"
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          focused.current = false
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(display)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : step)
            const cur = parseFloat(draft)
            const base = Number.isNaN(cur) ? (value ?? 0) : cur
            const next = min !== undefined ? Math.max(min, base + delta) : base + delta
            setDraft(String(Math.round(next * 100) / 100))
            onCommit(next)
          }
        }}
      />
    </label>
  )
}
