import { useEffect, useRef, useState } from 'react'
import {
  Check, CornerUpLeft, MessageCircle, Pencil, Sparkles, Trash2, X,
} from 'lucide-react'
import { cameraStore } from './camera'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import type { CommentDraft } from '../store/editorStore'
import type { CommentAuthor, CommentRect, CommentThread } from '../model/types'

/**
 * Comment overlay: world-anchored pins plus their hover popover, thread card,
 * and the new-comment composer. It is a React sibling of the canvas world (same
 * box as the canvas viewport, so cameraStore.worldToScreen maps 1:1), but stays
 * off React's render path during pan/zoom — every anchored element subscribes to
 * the camera and positions itself imperatively, like the selection overlay. The
 * layer only re-renders when comments or comment UI state change.
 */
export function CommentLayer() {
  useDocVersion()
  const ui = useUi()
  const activePageId = editorStore.doc.activePageId
  const threads = (editorStore.doc.comments ?? []).filter((t) => t.pageId === activePageId)
  const active = threads.find((t) => t.id === ui.activeCommentId)
  const draft = ui.commentDraft

  return (
    <div className="cz-comment-layer" data-cz-ui>
      {active?.area ? <CommentArea area={active.area} /> : null}
      {draft?.area ? <CommentArea area={draft.area} /> : null}
      {threads.map((thread) => (
        <CommentPin key={thread.id} thread={thread} active={thread.id === ui.activeCommentId} />
      ))}
      {draft ? <Composer draft={draft} /> : null}
    </div>
  )
}

/** Keep an absolutely-positioned element pinned to a world point as the camera moves. */
function useWorldAnchor(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number,
  y: number,
  cull: boolean,
) {
  useEffect(() => {
    const place = () => {
      const el = ref.current
      if (!el) return
      const s = cameraStore.worldToScreen(x, y)
      if (cull) {
        const v = document.querySelector<HTMLElement>('[data-canvas]')
        const w = v?.clientWidth ?? 0
        const h = v?.clientHeight ?? 0
        if (s.x < -80 || s.y < -80 || s.x > w + 80 || s.y > h + 80) {
          el.style.display = 'none'
          return
        }
        el.style.display = ''
      }
      el.style.transform = `translate(${s.x}px, ${s.y}px)`
    }
    place()
    const unsub = cameraStore.subscribe(place)
    return () => void unsub()
  }, [ref, x, y, cull])
}

/** Dashed outline of an area comment's world rectangle, scaled with the camera. */
function CommentArea({ area }: { area: CommentRect }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const place = () => {
      const el = ref.current
      if (!el) return
      const c = cameraStore.camera
      const s = cameraStore.worldToScreen(area.x, area.y)
      el.style.transform = `translate(${s.x}px, ${s.y}px)`
      el.style.width = `${area.width * c.scale}px`
      el.style.height = `${area.height * c.scale}px`
    }
    place()
    const unsub = cameraStore.subscribe(place)
    return () => void unsub()
  }, [area.x, area.y, area.width, area.height])
  return <div ref={ref} className="cz-comment-area" />
}

function CommentPin({ thread, active }: { thread: CommentThread; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  useWorldAnchor(ref, thread.x, thread.y, true)
  const replies = thread.messages.length - 1

  return (
    <div
      ref={ref}
      className="cz-comment-anchor"
      style={{ zIndex: active ? 30 : 10 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={thread.resolved ? 'Resolved comment' : 'Comment'}
        className={`cz-comment-pin${active ? ' cz-comment-pin--active' : ''}${
          thread.resolved ? ' cz-comment-pin--resolved' : ''
        }`}
        onClick={() =>
          editorStore.setUi({ activeCommentId: active ? null : thread.id, commentDraft: null })
        }
      >
        {thread.resolved ? <Check className="size-3.5" /> : <MessageCircle className="size-3.5" />}
        {replies > 0 ? <span className="cz-comment-pin__count">{replies + 1}</span> : null}
      </button>
      {active ? (
        <ThreadCard thread={thread} />
      ) : hovered ? (
        <PinPopover thread={thread} />
      ) : null}
    </div>
  )
}

/** Hover preview: the latest message plus open/delete shortcuts. */
function PinPopover({ thread }: { thread: CommentThread }) {
  const last = thread.messages[thread.messages.length - 1]
  return (
    <div className="cz-comment-surface absolute left-9 top-[-28px] w-56 p-2.5 text-[12px]">
      <div className="mb-1 flex items-center gap-1.5">
        <AuthorChip author={last.author} />
        <span className="text-[10px] text-[var(--cz-panel-muted)]">{timeAgo(last.createdAt)}</span>
        {thread.resolved ? (
          <span className="ml-auto text-[10px] font-medium text-[#30d158]">Resolved</span>
        ) : null}
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--cz-panel-fg)]">
        {last.body}
      </p>
      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          className="rounded-md bg-[var(--cz-panel-hover)] px-2 py-1 text-[11px] hover:bg-[var(--cz-panel-active)] hover:text-white"
          onClick={() => editorStore.setUi({ activeCommentId: thread.id, commentDraft: null })}
        >
          Open thread
        </button>
        <button
          type="button"
          aria-label="Delete comment"
          className="ml-auto rounded-md p-1 text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-[#FF453A]"
          onClick={() => editorStore.deleteCommentThread(thread.id)}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** The full thread: messages, reply composer, resolve/reopen, delete, edit-latest. */
function ThreadCard({ thread }: { thread: CommentThread }) {
  const [reply, setReply] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const lastId = thread.messages[thread.messages.length - 1]?.id

  const sendReply = () => {
    const body = reply.trim()
    if (!body) return
    editorStore.addCommentMessage(thread.id, body, 'user')
    setReply('')
  }

  const saveEdit = () => {
    const body = editText.trim()
    if (body && editingId) editorStore.editCommentMessage(thread.id, editingId, body)
    setEditingId(null)
  }

  return (
    <div className="cz-comment-surface absolute left-9 top-[-28px] flex max-h-[60vh] w-72 flex-col text-[12px]">
      <div className="flex items-center gap-2 border-b border-[var(--cz-panel-border)] px-3 py-2">
        <span className="font-semibold text-[var(--cz-panel-fg)]">
          {thread.area ? 'Area comment' : 'Comment'}
        </span>
        {thread.nodeIds.length > 0 ? (
          <span className="text-[10px] text-[var(--cz-panel-muted)]">
            {thread.nodeIds.length} {thread.nodeIds.length === 1 ? 'node' : 'nodes'}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] ${
              thread.resolved
                ? 'text-[#30d158] hover:bg-[var(--cz-panel-hover)]'
                : 'text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-white'
            }`}
            title={thread.resolved ? 'Reopen thread' : 'Resolve thread'}
            onClick={() => editorStore.setCommentResolved(thread.id, !thread.resolved)}
          >
            {thread.resolved ? <CornerUpLeft className="size-3.5" /> : <Check className="size-3.5" />}
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
          <button
            type="button"
            aria-label="Delete comment"
            className="rounded-md p-1 text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-[#FF453A]"
            onClick={() => editorStore.deleteCommentThread(thread.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close thread"
            className="rounded-md p-1 text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-white"
            onClick={() => editorStore.setUi({ activeCommentId: null })}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {thread.messages.map((m) => (
          <div key={m.id} className={`cz-comment-msg${m.author === 'agent' ? ' cz-comment-msg--agent' : ''}`}>
            <div className="mb-1 flex items-center gap-1.5">
              <AuthorChip author={m.author} />
              <span className="text-[10px] text-[var(--cz-panel-muted)]">
                {timeAgo(m.createdAt)}
                {m.editedAt ? ' · edited' : ''}
              </span>
              {m.id === lastId && m.author === 'user' && editingId !== m.id ? (
                <button
                  type="button"
                  aria-label="Edit comment"
                  className="ml-auto rounded p-0.5 text-[var(--cz-panel-muted)] hover:text-white"
                  onClick={() => {
                    setEditingId(m.id)
                    setEditText(m.body)
                  }}
                >
                  <Pencil className="size-3" />
                </button>
              ) : null}
            </div>
            {editingId === m.id ? (
              <div className="flex flex-col gap-1.5">
                <textarea
                  autoFocus
                  rows={2}
                  className="w-full resize-none rounded-md p-1.5 text-[12px]"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') setEditingId(null)
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      saveEdit()
                    }
                  }}
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[11px] text-[var(--cz-panel-muted)] hover:text-white"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-[var(--cz-accent)] px-2 py-1 text-[11px] text-white"
                    onClick={saveEdit}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-[var(--cz-panel-fg)]">{m.body}</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-end gap-1.5 border-t border-[var(--cz-panel-border)] p-2">
        <textarea
          rows={1}
          placeholder={thread.resolved ? 'Reply to reopen…' : 'Reply…'}
          className="min-h-8 flex-1 resize-none rounded-md p-1.5 text-[12px]"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendReply()
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-[var(--cz-accent)] px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
          disabled={!reply.trim()}
          onClick={sendReply}
        >
          {thread.resolved ? 'Reply & reopen' : 'Reply'}
        </button>
      </div>
    </div>
  )
}

/** New-comment composer anchored at the draft point. */
function Composer({ draft }: { draft: CommentDraft }) {
  const ref = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState('')
  useWorldAnchor(ref, draft.x, draft.y, false)

  const submit = () => {
    const text = body.trim()
    if (!text) return editorStore.setUi({ commentDraft: null })
    const thread = editorStore.addCommentThread({
      x: draft.x, y: draft.y, nodeIds: draft.nodeIds, area: draft.area, body: text,
    })
    editorStore.setUi({ commentDraft: null, activeCommentId: thread.id })
  }

  const attached = draft.nodeIds.length
  return (
    <div ref={ref} className="cz-comment-anchor" style={{ zIndex: 40 }}>
      <div className="cz-comment-surface absolute left-4 top-[-10px] w-64 p-2.5">
        <div className="mb-1.5 text-[10px] text-[var(--cz-panel-muted)]">
          {draft.area
            ? `Area comment · ${attached} ${attached === 1 ? 'node' : 'nodes'}`
            : attached > 0
              ? 'Comment on this node'
              : 'Comment'}
        </div>
        <textarea
          autoFocus
          rows={3}
          placeholder="Write a comment…"
          className="w-full resize-none rounded-md p-1.5 text-[12px]"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') editorStore.setUi({ commentDraft: null })
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-[var(--cz-panel-muted)] hover:text-white"
            onClick={() => editorStore.setUi({ commentDraft: null })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-[var(--cz-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            disabled={!body.trim()}
            onClick={submit}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  )
}

function AuthorChip({ author }: { author: CommentAuthor }) {
  if (author === 'agent') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--cz-ai)]">
        <Sparkles className="size-3" /> Agent
      </span>
    )
  }
  return <span className="text-[11px] font-semibold text-[var(--cz-panel-fg)]">You</span>
}

/** Compact relative timestamp ("just now", "5m ago", "3h ago", "2d ago"). */
function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
