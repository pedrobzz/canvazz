import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { editorStore } from '../store/editorStore'

/**
 * Compact inspector fields. Inputs hold local draft state while focused and
 * commit on Enter/blur. Numeric fields are scrubbable: their icon label is a
 * drag handle — drag left to decrease, right to increase — and every commit
 * of one drag carries the same gestureId so it folds into a single undo step.
 */

/** Commits sharing a gestureId merge into one undo entry (drag gestures). */
export interface CommitOpts {
  gestureId?: string
}

let scrubSeq = 0

/** Styled tooltip around any trigger element. */
export function Tip({ label, side = 'top', children }: {
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="px-2 py-1 text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Small icon button for section headers and field-side toggles. */
export function IconButton({ label, onClick, active, disabled, children }: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        className={`flex size-6 shrink-0 items-center justify-center rounded-md disabled:opacity-40 ${
          active
            ? 'bg-[var(--cz-panel-active)] text-[var(--cz-accent)]'
            : 'text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-white'
        }`}
        onClick={onClick}
      >
        {children}
      </button>
    </Tip>
  )
}

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
  label?: React.ReactNode
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <div className="cz-field min-w-0 flex-1">
      {label !== undefined ? <span className="cz-field-handle">{label}</span> : null}
      <input
        value={draft}
        placeholder={placeholder}
        className={mono ? 'font-mono' : undefined}
        style={label === undefined ? { paddingLeft: 8 } : undefined}
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
    </div>
  )
}

interface ScrubState {
  startX: number
  base: number
  gestureId: string
  active: boolean
  raf: number
  pending: number | null
}

/**
 * Drag-to-scrub behavior for a field's icon label. Returns pointer handlers;
 * `commit` receives the live value plus the gesture id for undo merging.
 */
function useScrub({ base, step, clamp, disabled, commit, preview }: {
  base: () => number
  step: number
  clamp: (n: number) => number
  disabled?: boolean
  commit: (next: number, opts: CommitOpts) => void
  preview: (next: number) => void
}) {
  const state = useRef<ScrubState | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  const flush = () => {
    const s = state.current
    if (!s) return
    s.raf = 0
    if (s.pending !== null) {
      commitRef.current(s.pending, { gestureId: s.gestureId })
      s.pending = null
    }
  }

  if (disabled) return {}
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        // Synthesized events (tests) carry no active pointer; scrub still works.
      }
      state.current = {
        startX: e.clientX,
        base: base(),
        gestureId: `scrub-${++scrubSeq}`,
        active: false,
        raf: 0,
        pending: null,
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = state.current
      if (!s) return
      const dx = e.clientX - s.startX
      if (!s.active && Math.abs(dx) < 3) return
      s.active = true
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      const next = clamp(s.base + dx * step * mult)
      preview(next)
      s.pending = next
      if (!s.raf) s.raf = requestAnimationFrame(flush)
    },
    onPointerUp: () => {
      const s = state.current
      if (s?.raf) cancelAnimationFrame(s.raf)
      flush()
      state.current = null
    },
    onPointerCancel: () => {
      const s = state.current
      if (s?.raf) cancelAnimationFrame(s.raf)
      if (s) s.pending = null
      state.current = null
    },
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function NumberField({
  value,
  onCommit,
  label,
  step = 1,
  min,
  max,
  unit = 'px',
  disabled,
  title,
}: {
  /** Current numeric value, or null when mixed/unset. */
  value: number | null
  onCommit: (next: number, opts?: CommitOpts) => void
  /** Icon or letter shown at the left — doubles as the scrub handle. */
  label?: React.ReactNode
  step?: number
  min?: number
  max?: number
  /** Suffix shown inside the field (px, %, °). Display only. */
  unit?: string
  disabled?: boolean
  /** Accessible name for the scrub handle. */
  title?: string
}) {
  const display = value === null ? '' : String(round2(value))
  const [draft, setDraft] = useState(display)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(display)
  }, [display])

  const clamp = (n: number) => {
    let next = n
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    return round2(next)
  }

  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) {
      const clamped = clamp(n)
      setDraft(String(clamped))
      if (clamped !== value) onCommit(clamped)
    } else {
      setDraft(display)
    }
  }

  const scrub = useScrub({
    base: () => value ?? (parseFloat(draft) || 0),
    step,
    clamp,
    disabled,
    commit: (next, opts) => onCommit(next, opts),
    preview: (next) => setDraft(String(next)),
  })

  return (
    <div className="cz-field min-w-0 flex-1" data-disabled={disabled ? 'true' : undefined}>
      {label !== undefined ? (
        <span
          className="cz-field-handle"
          data-scrub={disabled ? undefined : ''}
          aria-hidden
          title={disabled ? undefined : title}
          {...scrub}
        >
          {label}
        </span>
      ) : null}
      <input
        value={draft}
        inputMode="decimal"
        disabled={disabled}
        aria-label={title}
        style={label === undefined ? { paddingLeft: 8 } : undefined}
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
            const next = clamp(base + delta)
            setDraft(String(next))
            onCommit(next)
          }
        }}
      />
      {unit ? <span className="cz-field-unit">{unit}</span> : null}
    </div>
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

/** Opacity of a color value as 0–100 (hex8 / rgba / hsla; else fully opaque). */
function alphaOf(value: string): number {
  const v = resolveColorValue(value).trim()
  const hex = HEX_RE.exec(v)
  if (hex) {
    return hex[1].length === 8 ? Math.round((parseInt(hex[1].slice(6, 8), 16) / 255) * 100) : 100
  }
  const fn = /^(?:rgba?|hsla?)\(([^)]*)\)$/i.exec(v)
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => p.trim()).filter(Boolean)
    if (parts.length === 4) {
      const a = parseFloat(parts[3])
      if (!Number.isNaN(a)) return Math.round((parts[3].endsWith('%') ? a / 100 : a) * 100)
    }
  }
  return 100
}

/** Re-emit a color with the given opacity. Token/keyword values pass through. */
function withAlpha(value: string, pct: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const v = value.trim()
  if (HEX_RE.test(v)) {
    const base = toPickerHex(v)
    if (clamped >= 100) return base
    return base + Math.round((clamped / 100) * 255).toString(16).padStart(2, '0')
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(v)
  if (fn) {
    const parts = fn[2].split(/[,/]/).map((p) => p.trim()).filter(Boolean)
    const base = parts.slice(0, 3).join(', ')
    const kind = fn[1].toLowerCase().startsWith('rgb') ? 'rgb' : 'hsl'
    return clamped >= 100 ? `${kind}(${base})` : `${kind}a(${base}, ${round2(clamped / 100)})`
  }
  return v
}

/**
 * Figma-style color row: swatch, value, opacity %. Tokens stay as
 * `var(--name)` in the text input; the palette menu applies tokens.
 */
export function ColorField({
  value,
  onCommit,
  allowEmpty,
  trailing,
}: {
  value: string
  onCommit: (next: string | null, opts?: CommitOpts) => void
  /** Show a remove button that clears the property. */
  allowEmpty?: boolean
  /** Extra buttons rendered after the palette menu (eye toggles, …). */
  trailing?: React.ReactNode
}) {
  const resolved = resolveColorValue(value)
  const isToken = TOKEN_RE.test(value.trim())
  const alphaEditable = Boolean(value) && !isToken
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="cz-field min-w-0 flex-1">
        <span className="cz-field-handle" style={{ paddingLeft: 5 }}>
          <input
            type="color"
            className="cz-swatch"
            aria-label="Pick color"
            value={toPickerHex(resolved || '#000000')}
            onChange={(e) => onCommit(withAlpha(e.target.value, alphaOf(value)))}
          />
        </span>
        <ColorTextInput value={value} onCommit={(v) => onCommit(v || null)} />
        <AlphaInput
          value={value ? alphaOf(value) : null}
          disabled={!alphaEditable}
          onCommit={(pct, opts) => onCommit(withAlpha(resolved, pct), opts)}
        />
      </div>
      <TokenMenu onPick={(name) => onCommit(`var(--${name})`)} />
      {trailing}
      {allowEmpty && value ? (
        <IconButton label="Remove" onClick={() => onCommit(null)}>
          <Icon name="minus" size={11} />
        </IconButton>
      ) : null}
    </div>
  )
}

function ColorTextInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <input
      value={draft}
      placeholder="none"
      spellCheck={false}
      aria-label="Color value"
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false
        if (draft !== value) onCommit(draft.trim())
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
  )
}

/** Opacity sub-field inside a color row, scrubbable on its divider zone. */
function AlphaInput({ value, disabled, onCommit }: {
  value: number | null
  disabled?: boolean
  onCommit: (pct: number, opts?: CommitOpts) => void
}) {
  const display = value === null ? '' : String(value)
  const [draft, setDraft] = useState(display)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(display)
  }, [display])
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
  const scrub = useScrub({
    base: () => value ?? 100,
    step: 1,
    clamp,
    disabled,
    commit: (next, opts) => onCommit(next, opts),
    preview: (next) => setDraft(String(next)),
  })
  return (
    <>
      <span
        className="h-3.5 w-px shrink-0 bg-[var(--cz-panel-border)]"
        data-scrub={disabled ? undefined : ''}
        style={disabled ? undefined : { cursor: 'ew-resize', touchAction: 'none' }}
        {...scrub}
      />
      <input
        value={draft}
        inputMode="numeric"
        disabled={disabled}
        aria-label="Opacity"
        style={{ flex: 'none', width: 30, textAlign: 'right' }}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          focused.current = false
          const n = parseFloat(e.target.value)
          if (!Number.isNaN(n)) onCommit(clamp(n))
          else setDraft(display)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(display)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <span className="cz-field-unit">%</span>
    </>
  )
}

/** Palette menu applying a color token as var(--name). */
function TokenMenu({ onPick }: { onPick: (name: string) => void }) {
  const tokens = Object.entries(editorStore.doc.tokens)
  if (tokens.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Use color token"
          title="Color tokens"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-white"
        >
          <Icon name="paintpalette" size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="cz-panel min-w-[9rem] border-[var(--cz-panel-border)] p-1 text-[12px]"
      >
        {tokens.map(([name, color]) => (
          <DropdownMenuItem
            key={name}
            className="gap-2 rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
            onSelect={() => onPick(name)}
          >
            <span
              className="size-3.5 shrink-0 rounded-sm border border-[var(--cz-panel-border)]"
              style={{ background: color }}
            />
            <span className="truncate font-mono text-[11px]">{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      {label ? <span className="shrink-0 text-[10px] text-[var(--cz-panel-muted)]">{label}</span> : null}
      <select
        value={value}
        className="h-[26px] !rounded-md"
        onChange={(e) => onCommit(e.target.value)}
      >
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

const SIZE_MODE_LABELS: Record<SizeMode, string> = {
  fixed: 'Fixed',
  fit: 'Fit content',
  fill: 'Fill container',
}

/**
 * Dimension field: scrubbable axis label, one input (accepts `300` or `50%`),
 * and a unit dropdown for Fixed / Fit / Fill. Typing or scrubbing implies
 * Fixed.
 */
export function SizeField({
  label,
  mode,
  display,
  live,
  onFixed,
  onMode,
  title,
}: {
  label: string
  mode: SizeMode
  /** Shown when fixed: a number (px) or a percentage string. */
  display: string
  /** Rendered size — scrub base when the value is fit/fill. Lazy: reading it
   * forces a layout pass, so it only runs at gesture start. */
  live?: () => number | null
  onFixed: (raw: string, opts?: CommitOpts) => void
  onMode: (mode: SizeMode) => void
  title?: string
}) {
  const shown = mode === 'fixed' ? display : ''
  const [draft, setDraft] = useState(shown)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(shown)
  }, [shown])

  const isPct = display.trim().endsWith('%')
  const scrub = useScrub({
    base: () => parseFloat(display) || live?.() || 0,
    step: 1,
    clamp: (n) => Math.max(1, round2(n)),
    commit: (next, opts) => onFixed(isPct ? `${next}%` : String(next), opts),
    preview: (next) => setDraft(String(next)),
  })

  const pickMode = (next: SizeMode) => {
    if (next === 'fixed') onFixed(display || '')
    else onMode(next)
  }
  const unitLabel = mode === 'fixed' ? (isPct ? '%' : 'px') : mode === 'fit' ? 'Fit' : 'Fill'

  return (
    // modal=false: a unit picker must not lock pointer events on the whole
    // app — rapid field-to-field editing keeps working mid-animation.
    <div className="cz-field min-w-0 flex-1">
      <span
        className="cz-field-handle"
        data-scrub=""
        aria-hidden
        title={title}
        {...scrub}
      >
        {label}
      </span>
      <input
        value={draft}
        placeholder={mode === 'fit' ? 'Fit' : mode === 'fill' ? 'Fill' : ''}
        inputMode="decimal"
        aria-label={title ?? `${label} size`}
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label} sizing mode`}
            className="flex h-full shrink-0 items-center gap-0.5 pl-1 pr-1.5 text-[10px] text-[var(--cz-panel-muted)] hover:text-white"
          >
            {unitLabel}
            <Icon name="chevron.down" size={8} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="cz-panel min-w-[8rem] border-[var(--cz-panel-border)] p-1 text-[12px]"
        >
          {(['fixed', 'fit', 'fill'] as const).map((m) => (
            <DropdownMenuItem
              key={m}
              className="gap-2 rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
              onSelect={() => pickMode(m)}
            >
              <span className="flex w-3.5 items-center justify-center">
                {mode === m ? <Icon name="checkmark" size={12} /> : null}
              </span>
              {SIZE_MODE_LABELS[m]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
      className="grid w-[78px] shrink-0 grid-cols-3 gap-px rounded-md bg-[var(--cz-panel-hover)] p-1"
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
              className="flex h-5 items-center justify-center rounded-sm hover:bg-[var(--cz-panel-active)]"
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

/** Segmented icon toggle (flow direction, text align, …) with tooltips. */
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
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md bg-[var(--cz-panel-hover)] p-0.5"
    >
      {options.map((o) => (
        <Tip key={o.value} label={o.label}>
          <button
            type="button"
            aria-label={o.label}
            aria-pressed={value === o.value}
            className={`flex h-full flex-1 items-center justify-center rounded-[5px] ${
              value === o.value
                ? 'bg-[var(--cz-panel-active)] text-white shadow-sm'
                : 'text-[var(--cz-panel-muted)] hover:text-white'
            }`}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
          </button>
        </Tip>
      ))}
    </div>
  )
}

/** Row of one-shot action icon buttons (align to parent, rotate, …). */
export function ActionRow({
  actions,
  fullWidth,
}: {
  actions: Array<{ icon: React.ReactNode; label: string; onClick: () => void }>
  /** Span the full panel width instead of sharing a row with siblings. */
  fullWidth?: boolean
}) {
  return (
    <div
      className={`flex h-7 items-center justify-between gap-0.5 rounded-md bg-[var(--cz-panel-hover)] p-0.5 ${
        fullWidth ? 'w-full' : 'min-w-0 flex-1'
      }`}
    >
      {actions.map((a) => (
        <Tip key={a.label} label={a.label}>
          <button
            type="button"
            aria-label={a.label}
            className="flex h-full flex-1 items-center justify-center rounded-[5px] text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-active)] hover:text-white"
            onClick={a.onClick}
          >
            {a.icon}
          </button>
        </Tip>
      ))}
    </div>
  )
}

/** Labeled checkbox row (Clip content, Border box, …). */
export function CheckRow({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex h-6 cursor-default select-none items-center gap-2 text-[11px] text-[var(--cz-panel-fg)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/** Small muted label above a control group, with optional trailing action. */
export function FieldLabel({ children, action }: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-4 items-center justify-between text-[10.5px] font-medium text-[var(--cz-panel-muted)]">
      <span>{children}</span>
      {action}
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
    <div className="border-b border-[var(--cz-panel-border)] px-3 py-3" data-section={slug}>
      <div className={`flex min-h-6 items-center justify-between ${showBody ? 'mb-2' : ''}`}>
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex flex-1 items-center justify-between text-[11.5px] font-semibold text-[var(--cz-panel-fg)]"
            onClick={() => setOpen(!open)}
          >
            {title}
            <span className="flex size-6 items-center justify-center text-[var(--cz-panel-muted)]">
              <Icon name={open ? 'minus' : 'plus'} size={11} />
            </span>
          </button>
        ) : (
          <span className="text-[11.5px] font-semibold text-[var(--cz-panel-fg)]">{title}</span>
        )}
        {actions}
      </div>
      {showBody ? <div className="flex flex-col gap-2">{children}</div> : null}
    </div>
  )
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>
}
