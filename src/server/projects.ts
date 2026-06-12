import '@tanstack/react-start/server-only'
import { db } from './db'
import type { DocumentModel } from '#/editor/model/types'

/**
 * Project store queries (server-only). A project is one DocumentModel (pages,
 * components, tokens — the whole design system) plus listing metadata,
 * persisted as a row in the libSQL database. The project id is the document
 * id. Client code calls these through the server functions in projectFns.ts;
 * the MCP endpoint uses them directly.
 */

export interface ProjectMeta {
  id: string
  name: string
  thumbnail: string | null
  createdAt: number
  updatedAt: number
}

type MetaRow = {
  id: string
  name: string
  thumbnail: string | null
  created_at: number
  updated_at: number
}

const META_COLS = 'id, name, thumbnail, created_at, updated_at'

function toMeta(row: MetaRow): ProjectMeta {
  return {
    id: row.id,
    name: row.name,
    thumbnail: row.thumbnail,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export async function listProjectsQuery(): Promise<ProjectMeta[]> {
  const client = await db()
  const result = await client.execute(
    `SELECT ${META_COLS} FROM projects ORDER BY updated_at DESC`,
  )
  return (result.rows as unknown as MetaRow[]).map(toMeta)
}

export async function getProjectQuery(id: string): Promise<DocumentModel | null> {
  const client = await db()
  const result = await client.execute({
    sql: 'SELECT doc FROM projects WHERE id = ?',
    args: [id],
  })
  const row = result.rows[0] as unknown as { doc: string } | undefined
  return row ? (JSON.parse(row.doc) as DocumentModel) : null
}

export async function insertProject(doc: DocumentModel): Promise<ProjectMeta> {
  const client = await db()
  const now = Date.now()
  await client.execute({
    sql: 'INSERT INTO projects (id, name, doc, thumbnail, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
    args: [doc.id, doc.name, JSON.stringify(doc), now, now],
  })
  return { id: doc.id, name: doc.name, thumbnail: null, createdAt: now, updatedAt: now }
}

export async function updateProjectDoc(id: string, doc: DocumentModel): Promise<boolean> {
  const client = await db()
  const result = await client.execute({
    sql: 'UPDATE projects SET name = ?, doc = ?, updated_at = ? WHERE id = ?',
    args: [doc.name, JSON.stringify(doc), Date.now(), id],
  })
  return result.rowsAffected > 0
}

export async function renameProjectQuery(id: string, name: string): Promise<void> {
  const client = await db()
  // Keep the doc's embedded name in sync without a parse round trip.
  await client.execute({
    sql: "UPDATE projects SET name = ?, doc = json_set(doc, '$.name', ?), updated_at = ? WHERE id = ?",
    args: [name, name, Date.now(), id],
  })
}

export async function duplicateProjectQuery(id: string, newId: string): Promise<ProjectMeta> {
  const client = await db()
  const now = Date.now()
  const result = await client.execute({
    sql: `INSERT INTO projects (id, name, doc, thumbnail, created_at, updated_at)
          SELECT ?, name || ' copy', json_set(doc, '$.id', ?, '$.name', name || ' copy'), thumbnail, ?, ?
          FROM projects WHERE id = ?
          RETURNING ${META_COLS}`,
    args: [newId, newId, now, now, id],
  })
  const row = result.rows[0] as unknown as MetaRow | undefined
  if (!row) throw new Error(`Unknown project: ${id}`)
  return toMeta(row)
}

export async function deleteProjectQuery(id: string): Promise<void> {
  const client = await db()
  await client.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [id] })
}

export async function saveThumbnailQuery(id: string, dataUrl: string): Promise<void> {
  const client = await db()
  // No updated_at bump: a thumbnail refresh is not an edit.
  await client.execute({
    sql: 'UPDATE projects SET thumbnail = ? WHERE id = ?',
    args: [dataUrl, id],
  })
}
