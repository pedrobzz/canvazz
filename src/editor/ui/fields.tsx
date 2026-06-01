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
