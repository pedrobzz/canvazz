import { useEffect, useRef, useState } from 'react'
import { editorStore } from '../store/editorStore'

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
  label?: React.ReactNode
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

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const TOKEN_RE = /^var\(\s*--([\w-]+)\s*\)$/

/** Resolve `var(--token)` color values to the token's current color. */
export function resolveColorValue(value: string): string {
  const m = TOKEN_RE.exec(value.trim())
  if (m) return editorStore.doc.tokens[m[1]] ?? '#000000'
  return value
}

/** Best-effort conversion of a CSS color to a hex the native picker accepts. */
export function toPickerHex(value: string): string {
  if (HEX_RE.test(value)) return value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value.slice(0, 7)
  if (typeof document !== 'undefined') {
    const probe = document.createElement('div')
    probe.style.color = value
    if (probe.style.color) {
      document.body.appendChild(probe)
      const rgb = getComputedStyle(probe).color.match(/\d+/g)
      probe.remove()
      if (rgb && rgb.length >= 3) {
        return `#${rgb.slice(0, 3).map((c) => (+c).toString(16).padStart(2, '0')).join('')}`
      }
    }
  }
  return '#000000'
}

export function ColorField({
  value,
  onCommit,
  label,
  allowEmpty,
}: {
  value: string
  onCommit: (next: string | null) => void
  label?: string
  /** Show a clear button that removes the property. */
  allowEmpty?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {label ? <span className="w-10 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span> : null}
      <input
        type="color"
        className="shrink-0 cursor-pointer"
        value={toPickerHex(resolveColorValue(value) || '#000000')}
        onChange={(e) => onCommit(e.target.value)}
      />
      <TextField value={value} onCommit={(v) => onCommit(v || null)} placeholder="none" mono />
      <TokenSelect onPick={(name) => onCommit(`var(--${name})`)} />
      {allowEmpty && value ? (
        <button
          className="shrink-0 text-[10px] text-[var(--cz-panel-muted)] hover:text-[var(--cz-panel-fg)]"
          onClick={() => onCommit(null)}
          title="Remove"
        >
          ✕
        </button>
      ) : null}
    </div>
  )
}

/** Compact dropdown applying a color token as var(--name). */
function TokenSelect({ onPick }: { onPick: (name: string) => void }) {
  const names = Object.keys(editorStore.doc.tokens)
  if (names.length === 0) return null
  return (
    <select
      aria-label="Use color token"
      title="Use color token"
      className="shrink-0 cursor-pointer"
      style={{ width: 24 }}
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value)
      }}
    >
      <option value="">◇</option>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  )
}

export function SelectField({
  value,
  options,
  onCommit,
  label,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onCommit: (next: string) => void
  label?: string
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      {label ? <span className="w-10 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span> : null}
      <select value={value} onChange={(e) => onCommit(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export type SizeMode = 'fixed' | 'fit' | 'fill'

/**
 * Figma-style dimension field: a value input (accepts `300` or `50%`) plus a
 * Fixed / Fit / Fill mode dropdown. Typing a value implies Fixed.
 */
export function SizeField({
  label,
  mode,
  display,
  onFixed,
  onMode,
}: {
  label: string
  mode: SizeMode
  /** Shown when fixed: a number (px) or a percentage string. */
  display: string
  onFixed: (raw: string) => void
  onMode: (mode: SizeMode) => void
}) {
  const shown = mode === 'fixed' ? display : ''
  const [draft, setDraft] = useState(shown)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(shown)
  }, [shown])

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <span className="w-3 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span>
      <label className="min-w-0 flex-1">
        <input
          value={draft}
          placeholder={mode === 'fit' ? 'Fit' : mode === 'fill' ? 'Fill' : ''}
          inputMode="decimal"
          onFocus={() => (focused.current = true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            focused.current = false
            const raw = e.target.value.trim()
            if (raw && raw !== shown) onFixed(raw)
            else if (!raw) setDraft(shown)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(shown)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </label>
      <select
        aria-label={`${label} sizing mode`}
        className="shrink-0"
        // Inline width: the unlayered .cz-panel select rule sets width:100%.
        style={{ width: 58 }}
        value={mode}
        onChange={(e) => {
          const next = e.target.value as SizeMode
          if (next === 'fixed') onFixed(display || '')
          else onMode(next)
        }}
      >
        <option value="fixed">Fixed</option>
        <option value="fit">Fit</option>
        <option value="fill">Fill</option>
      </select>
    </div>
  )
}

const ALIGN_VALUES = ['flex-start', 'center', 'flex-end'] as const

/**
 * Figma's 3×3 alignment matrix for auto-layout containers. One click sets
 * both justify-content (main axis) and align-items (cross axis).
 */
export function AlignmentGrid({
  direction,
  justify,
  align,
  onChange,
}: {
  direction: 'row' | 'column'
  justify: string
  align: string
  onChange: (justify: string, align: string) => void
}) {
  const j = justify || 'flex-start'
  const a = align || 'stretch'
  return (
    <div
      role="group"
      aria-label="Alignment"
      className="grid w-[66px] shrink-0 grid-cols-3 gap-px rounded bg-[var(--cz-panel-hover)] p-1"
    >
      {[0, 1, 2].flatMap((rowI) =>
        [0, 1, 2].map((colI) => {
          const cellJ = direction === 'row' ? ALIGN_VALUES[colI] : ALIGN_VALUES[rowI]
          const cellA = direction === 'row' ? ALIGN_VALUES[rowI] : ALIGN_VALUES[colI]
          const active = j === cellJ && a === cellA
          return (
            <button
              key={`${rowI}-${colI}`}
              type="button"
              title={`${cellJ.replace('flex-', '')} / ${cellA.replace('flex-', '')}`}
              aria-pressed={active}
              className="flex h-4 items-center justify-center rounded-sm hover:bg-[var(--cz-panel-active)]"
              onClick={() => onChange(cellJ, cellA)}
            >
              <span
                className={`rounded-full ${
                  active ? 'size-2 bg-[var(--cz-accent)]' : 'size-1 bg-[var(--cz-panel-muted)]'
                }`}
              />
            </button>
          )
        }),
      )}
    </div>
  )
}

/** Segmented icon toggle (flex direction, text align, …). */
export function IconRow<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: Array<{ value: T; icon: React.ReactNode; label: string }>
  onChange: (next: T) => void
  ariaLabel?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex min-w-0 flex-1 overflow-hidden rounded bg-[var(--cz-panel-hover)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.label}
          aria-label={o.label}
          aria-pressed={value === o.value}
          className={`flex h-6 flex-1 items-center justify-center ${
            value === o.value
              ? 'bg-[var(--cz-panel-active)] text-white'
              : 'text-[var(--cz-panel-muted)] hover:text-white'
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  )
}

/** Row of one-shot action icon buttons (align to parent, …). */
export function ActionRow({
  actions,
}: {
  actions: Array<{ icon: React.ReactNode; label: string; onClick: () => void }>
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between rounded bg-[var(--cz-panel-hover)] px-0.5">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          title={a.label}
          aria-label={a.label}
          className="flex h-6 flex-1 items-center justify-center text-[var(--cz-panel-muted)] hover:text-white"
          onClick={a.onClick}
        >
          {a.icon}
        </button>
      ))}
    </div>
  )
}

export function Section({ title, children, actions, collapsible, defaultOpen = true }: {
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
  /** Collapsed sections render as a "+" header row, like Figma's add-ables. */
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const showBody = !collapsible || open
  return (
    <div className="border-b border-[var(--cz-panel-border)] px-3 py-2.5" data-section={slug}>
      <div className={`flex items-center justify-between ${showBody ? 'mb-2' : ''}`}>
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex flex-1 items-center justify-between text-[11px] font-semibold text-[var(--cz-panel-fg)]"
            onClick={() => setOpen(!open)}
          >
            {title}
            <span className="text-[13px] leading-none text-[var(--cz-panel-muted)]">{open ? '−' : '+'}</span>
          </button>
        ) : (
          <span className="text-[11px] font-semibold text-[var(--cz-panel-fg)]">{title}</span>
        )}
        {actions}
      </div>
      {showBody ? <div className="flex flex-col gap-1.5">{children}</div> : null}
    </div>
  )
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>
}
