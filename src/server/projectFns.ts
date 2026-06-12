import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { genId } from '#/editor/model/ids'
import type { DocumentModel } from '#/editor/model/types'

/**
 * Server functions for the project store — the client-callable API over the
 * server-only queries in projects.ts. Server modules are referenced only
 * inside handlers so the client build compiles them away to RPC stubs.
 */

/** Light structural check; deep sanitization happens in the editor model. */
const docSchema = z.custom<DocumentModel>(
  (v) =>
    typeof v === 'object' && v !== null &&
    typeof (v as DocumentModel).id === 'string' &&
    typeof (v as DocumentModel).name === 'string' &&
    Array.isArray((v as DocumentModel).pages) &&
    typeof (v as DocumentModel).nodes === 'object',
  'Expected a DocumentModel',
)

export const listProjects = createServerFn({ method: 'GET' }).handler(async () =>
  (await import('./projects')).listProjectsQuery(),
)

export const getProject = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await import('./projects')).getProjectQuery(data.id))

export const createProject = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ doc: docSchema }))
  .handler(async ({ data }) => (await import('./projects')).insertProject(data.doc))

export const saveProject = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string(), doc: docSchema }))
  .handler(async ({ data }) => {
    if (!(await (await import('./projects')).updateProjectDoc(data.id, data.doc))) {
      throw new Error(`Unknown project: ${data.id}`)
    }
  })

export const renameProject = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string(), name: z.string().min(1).max(120) }))
  .handler(async ({ data }) =>
    (await import('./projects')).renameProjectQuery(data.id, data.name),
  )

export const duplicateProject = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) =>
    (await import('./projects')).duplicateProjectQuery(data.id, genId('doc')),
  )

export const deleteProject = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await import('./projects')).deleteProjectQuery(data.id))

export const saveThumbnail = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string(), dataUrl: z.string().startsWith('data:image/') }))
  .handler(async ({ data }) =>
    (await import('./projects')).saveThumbnailQuery(data.id, data.dataUrl),
  )
