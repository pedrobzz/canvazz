import { QueryClient } from '@tanstack/react-query'
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { deleteProject, listProjects, renameProject } from '#/server/projectFns'
import type { ProjectMeta } from '#/server/projects'

/**
 * TanStack DB collection over project metadata. Reads sync from the libSQL
 * store through server functions; renames and deletes apply optimistically
 * and persist in the mutation handlers. Project creation goes through
 * createProject/duplicateProject directly (the server owns doc content and
 * ids) followed by utils.refetch().
 */

const queryClient = new QueryClient()

export const projectsCollection = createCollection(
  queryCollectionOptions<ProjectMeta>({
    id: 'projects',
    queryKey: ['projects'],
    queryFn: () => listProjects(),
    queryClient,
    getKey: (p) => p.id,
    onUpdate: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        const name = (m.changes as Partial<ProjectMeta>).name
        if (name) await renameProject({ data: { id: String(m.key), name } })
      }
    },
    onDelete: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        await deleteProject({ data: { id: String(m.key) } })
      }
    },
  }),
)
