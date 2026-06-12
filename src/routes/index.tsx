import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { gt, ilike, useLiveQuery } from '@tanstack/react-db'
import { LayoutGrid, List, Plus, Search } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { seedDocument } from '#/editor/model/seed'
import { takeLegacyDocument } from '#/editor/store/persistence'
import { projectsCollection } from '#/lib/projectsCollection'
import { createProject, duplicateProject } from '#/server/projectFns'
import { cn } from '#/lib/utils'
import type { ProjectMeta } from '#/server/projects'

export const Route = createFileRoute('/')({
  // Pure client page: the projects collection syncs over server functions.
  ssr: false,
  component: FilesPage,
})

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} minute${s < 120 ? '' : 's'} ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} hour${s < 7200 ? '' : 's'} ago`
  const days = Math.floor(s / 86_400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function FilesPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'all' | 'recents'>('all')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: projects, isReady } = useLiveQuery(
    (q) => {
      let query = q.from({ p: projectsCollection })
      if (search.trim()) {
        query = query.where(({ p }) => ilike(p.name, `%${search.trim()}%`))
      }
      if (tab === 'recents') {
        query = query.where(({ p }) => gt(p.updatedAt, Date.now() - RECENT_WINDOW_MS))
      }
      return query.orderBy(({ p }) => p.updatedAt, 'desc')
    },
    [search, tab],
  )

  // One-time import of the pre-multi-project IndexedDB document.
  useEffect(() => {
    void takeLegacyDocument().then(async (doc) => {
      if (!doc) return
      await createProject({ data: { doc } }).catch(() => null)
      await projectsCollection.utils.refetch()
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openProject = (id: string) =>
    navigate({ to: '/p/$projectId', params: { projectId: id } })

  const handleNewFile = async () => {
    const meta = await createProject({ data: { doc: seedDocument() } })
    await projectsCollection.utils.refetch()
    void openProject(meta.id)
  }

  const handleDuplicate = async (id: string) => {
    await duplicateProject({ data: { id } })
    await projectsCollection.utils.refetch()
  }

  return (
    <div className="h-screen overflow-y-auto bg-[var(--cz-canvas-bg)] text-[var(--cz-panel-fg)]">
      <div className="mx-auto max-w-[1400px] px-10 py-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Files</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-lg bg-[var(--cz-panel)] p-0.5">
              {(['all', 'recents'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    'rounded-md px-3 py-1 text-[12px] capitalize transition-colors',
                    tab === t
                      ? 'bg-[var(--cz-panel-active)] text-white'
                      : 'text-[var(--cz-panel-muted)] hover:text-[var(--cz-panel-fg)]',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center rounded-lg bg-[var(--cz-panel)] p-0.5">
              {(
                [
                  ['grid', LayoutGrid],
                  ['list', List],
                ] as const
              ).map(([v, Icon]) => (
                <button
                  key={v}
                  type="button"
                  aria-label={`${v} view`}
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-md px-2 py-1 transition-colors',
                    view === v
                      ? 'bg-[var(--cz-panel-active)] text-white'
                      : 'text-[var(--cz-panel-muted)] hover:text-[var(--cz-panel-fg)]',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
            <label className="flex h-7 w-56 items-center gap-2 rounded-lg bg-[var(--cz-panel)] px-2.5 focus-within:ring-1 focus-within:ring-[var(--cz-accent)]">
              <Search className="size-3.5 text-[var(--cz-panel-muted)]" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-white placeholder-[var(--cz-panel-muted)] outline-none"
              />
              <kbd className="text-[10px] text-[var(--cz-panel-muted)]">⌘F</kbd>
            </label>
            <button
              type="button"
              onClick={() => void handleNewFile()}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-white px-3 text-[12px] font-medium text-black transition-colors hover:bg-white/85"
            >
              <Plus className="size-3.5" />
              New file
            </button>
          </div>
        </div>

        {isReady && projects.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-32 text-[13px] text-[var(--cz-panel-muted)]">
            {search.trim() ? (
              <span>No files match “{search.trim()}”.</span>
            ) : (
              <>
                <span>No files yet.</span>
                <button
                  type="button"
                  onClick={() => void handleNewFile()}
                  className="text-[var(--cz-accent)] hover:underline"
                >
                  Create your first file
                </button>
              </>
            )}
          </div>
        )}

        {view === 'grid' ? (
          <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6 gap-y-8">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() => void openProject(p.id)}
                onDuplicate={() => void handleDuplicate(p.id)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-6 flex flex-col">
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onOpen={() => void openProject(p.id)}
                onDuplicate={() => void handleDuplicate(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Thumbnail({ project, className }: { project: ProjectMeta; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-[var(--cz-panel-border)] bg-[var(--cz-panel)]',
        className,
      )}
    >
      {project.thumbnail ? (
        <img
          src={project.thumbnail}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[11px] text-[var(--cz-panel-muted)]">
          No preview yet
        </div>
      )}
    </div>
  )
}

function NameLabel({
  project,
  renaming,
  setRenaming,
  className,
}: {
  project: ProjectMeta
  renaming: boolean
  setRenaming: (v: boolean) => void
  className?: string
}) {
  if (!renaming) {
    return <span className={cn('truncate text-[13px] text-white', className)}>{project.name}</span>
  }
  return (
    <input
      autoFocus
      defaultValue={project.name}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.currentTarget.value = project.name
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        const name = e.target.value.trim()
        if (name && name !== project.name) {
          projectsCollection.update(project.id, (draft) => {
            draft.name = name
          })
        }
        setRenaming(false)
      }}
      className={cn(
        'rounded border border-[var(--cz-accent)] bg-transparent px-1 text-[13px] text-white outline-none',
        className,
      )}
    />
  )
}

interface ItemProps {
  project: ProjectMeta
  onOpen: () => void
  onDuplicate: () => void
}

function ProjectItemMenu({
  project,
  onOpen,
  onDuplicate,
  onRename,
  children,
}: ItemProps & { onRename: () => void; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(`/p/${project.id}`, '_blank')}>
          Open in new tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem onSelect={onDuplicate}>Duplicate</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-red-400 focus:text-red-400"
          onSelect={() => projectsCollection.delete(project.id)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ProjectCard(props: ItemProps) {
  const { project, onOpen } = props
  const [renaming, setRenaming] = useState(false)
  return (
    <ProjectItemMenu {...props} onRename={() => setRenaming(true)}>
      <button
        type="button"
        onClick={onOpen}
        data-testid="project-card"
        className="group flex flex-col gap-2.5 text-left outline-none"
      >
        <Thumbnail
          project={project}
          className="aspect-[3/2] w-full transition-colors group-hover:border-[var(--cz-accent)]/60"
        />
        <div className="flex flex-col gap-0.5 px-0.5">
          <NameLabel project={project} renaming={renaming} setRenaming={setRenaming} />
          <span className="text-[11px] text-[var(--cz-panel-muted)]">
            Edited {timeAgo(project.updatedAt)}
          </span>
        </div>
      </button>
    </ProjectItemMenu>
  )
}

function ProjectRow(props: ItemProps) {
  const { project, onOpen } = props
  const [renaming, setRenaming] = useState(false)
  return (
    <ProjectItemMenu {...props} onRename={() => setRenaming(true)}>
      <button
        type="button"
        onClick={onOpen}
        data-testid="project-row"
        className="flex items-center gap-4 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--cz-panel-hover)]"
      >
        <Thumbnail project={project} className="h-12 w-[72px] shrink-0" />
        <NameLabel project={project} renaming={renaming} setRenaming={setRenaming} className="flex-1" />
        <span className="text-[11px] text-[var(--cz-panel-muted)]">
          Edited {timeAgo(project.updatedAt)}
        </span>
      </button>
    </ProjectItemMenu>
  )
}
