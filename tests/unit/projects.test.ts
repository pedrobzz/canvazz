import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'

// Point the store at a throwaway file before the first query opens it.
process.env.CANVAZZ_DB = join(mkdtempSync(join(tmpdir(), 'canvazz-test-')), 'test.db')

const {
  deleteProjectQuery,
  duplicateProjectQuery,
  getProjectQuery,
  insertProject,
  listProjectsQuery,
  renameProjectQuery,
  saveThumbnailQuery,
  updateProjectDoc,
} = await import('#/server/projects')

test('insert, list, and get round-trip the document', async () => {
  const a = emptyDocument('doc_a', 'Alpha')
  const b = emptyDocument('doc_b', 'Beta')
  await insertProject(a)
  await insertProject(b)

  const list = await listProjectsQuery()
  expect(list.map((p) => p.id)).toEqual(['doc_b', 'doc_a'])
  expect(list[1]).toMatchObject({ name: 'Alpha', thumbnail: null })

  expect(await getProjectQuery('doc_a')).toEqual(a)
  expect(await getProjectQuery('missing')).toBeNull()
})

test('updateProjectDoc saves the doc and syncs metadata', async () => {
  const doc = emptyDocument('doc_save', 'Before')
  await insertProject(doc)

  const renamed = { ...doc, name: 'After' }
  expect(await updateProjectDoc('doc_save', renamed)).toBe(true)
  expect(await updateProjectDoc('missing', renamed)).toBe(false)

  const meta = (await listProjectsQuery()).find((p) => p.id === 'doc_save')
  expect(meta?.name).toBe('After')
  expect((await getProjectQuery('doc_save'))?.name).toBe('After')
})

test('rename updates both the column and the embedded doc name', async () => {
  await insertProject(emptyDocument('doc_rename', 'Old'))
  await renameProjectQuery('doc_rename', 'New name')

  const meta = (await listProjectsQuery()).find((p) => p.id === 'doc_rename')
  expect(meta?.name).toBe('New name')
  expect((await getProjectQuery('doc_rename'))?.name).toBe('New name')
})

test('duplicate copies the doc under a fresh id', async () => {
  await insertProject(emptyDocument('doc_dup', 'Origin'))
  const copy = await duplicateProjectQuery('doc_dup', 'doc_dup2')

  expect(copy).toMatchObject({ id: 'doc_dup2', name: 'Origin copy' })
  const doc = await getProjectQuery('doc_dup2')
  expect(doc?.id).toBe('doc_dup2')
  expect(doc?.name).toBe('Origin copy')
  await expect(duplicateProjectQuery('missing', 'x')).rejects.toThrow('Unknown project')
})

test('thumbnail saves without bumping updated_at; delete removes the row', async () => {
  await insertProject(emptyDocument('doc_thumb', 'Thumb'))
  const before = (await listProjectsQuery()).find((p) => p.id === 'doc_thumb')
  await saveThumbnailQuery('doc_thumb', 'data:image/jpeg;base64,xyz')

  const after = (await listProjectsQuery()).find((p) => p.id === 'doc_thumb')
  expect(after?.thumbnail).toBe('data:image/jpeg;base64,xyz')
  expect(after?.updatedAt).toBe(before?.updatedAt)

  await deleteProjectQuery('doc_thumb')
  expect(await getProjectQuery('doc_thumb')).toBeNull()
})
