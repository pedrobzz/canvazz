// Side-effect import: registers the `server.handlers` route-option module
// augmentation from @tanstack/start-client-core.
import '@tanstack/react-start'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handleMcpRequest } from '#/utils/mcp-handler'
import { connectedProjects, dispatchToEditor } from '#/server/bridge'

/**
 * Canvazz MCP server. Paper-style contract: pick a project (list_projects),
 * gather context first (get_basic_info / get_tree_summary), make incremental
 * visible writes, read exactly what you need, edit specific nodes, and call
 * finish when done. Every mutation is transactional, undoable, sanitized, and
 * returns changed node ids plus summaries so follow-up reads are rarely
 * needed. Each tool call targets one project; the project must be open in an
 * editor tab (the browser is the execution environment).
 *
 * Connect: claude mcp add --transport http canvazz http://localhost:47823/mcp
 */

const server = new McpServer({ name: 'canvazz', version: '1.0.0' })

const id = z.string().describe('Node id (from get_tree_summary / get_basic_info)')
const project = z
  .string()
  .describe('Project id or exact name (see list_projects). Required for every canvas tool.')

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  isError?: boolean
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** Resolve a project reference (id, else unique name) against the store. */
async function resolveProjectId(ref: string): Promise<string> {
  const { listProjectsQuery } = await import('#/server/projects')
  const projects = await listProjectsQuery()
  if (projects.some((p) => p.id === ref)) return ref
  const byName = projects.filter((p) => p.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0].id
  if (byName.length > 1) {
    throw new Error(
      `Multiple projects are named "${ref}" — use an id: ${byName.map((p) => p.id).join(', ')}`,
    )
  }
  throw new Error(`Unknown project: ${ref}. Call list_projects to see what exists.`)
}

function forward(tool: string, timeoutMs = 20_000) {
  return async ({
    project: ref,
    ...args
  }: Record<string, unknown> & { project: string }): Promise<ToolResult> => {
    try {
      const projectId = await resolveProjectId(ref)
      const result = await dispatchToEditor(projectId, tool, args ?? {}, timeoutMs)
      if (
        tool === 'get_screenshot' &&
        result &&
        typeof result === 'object' &&
        'dataUrl' in result
      ) {
        const { dataUrl, width, height } = result as { dataUrl: string; width: number; height: number }
        const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl)
        if (match) {
          return {
            content: [
              { type: 'image', data: match[2], mimeType: match[1] },
              { type: 'text', text: JSON.stringify({ width, height }) },
            ],
          }
        }
      }
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  }
}

// --- Projects ----------------------------------------------------------------

server.registerTool('list_projects', {
  title: 'List projects',
  description:
    'ALWAYS CALL FIRST. Every other tool requires a project (id or name). Returns all projects in the store and whether each is open in a live editor tab (only open projects can be edited).',
  inputSchema: {},
}, async (): Promise<ToolResult> => {
  try {
    const { listProjectsQuery } = await import('#/server/projects')
    const open = new Set(connectedProjects())
    const projects = (await listProjectsQuery()).map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: new Date(p.updatedAt).toISOString(),
      open: open.has(p.id),
    }))
    return ok({
      projects,
      hint: 'Pass a project id (or unique name) as the `project` arg of every canvas tool. A project must be open in an editor tab to be edited: /p/<id> (default http://localhost:47823).',
    })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('create_project', {
  title: 'Create a project',
  description:
    'Create a new empty project (one page, no nodes). Returns its id; open /p/<id> in the Canvazz app to start editing it through the other tools.',
  inputSchema: { name: z.string().min(1).max(120).describe('Project name') },
}, async ({ name }: { name: string }): Promise<ToolResult> => {
  try {
    const [{ insertProject }, { emptyDocument }, { genId }] = await Promise.all([
      import('#/server/projects'),
      import('#/editor/model/doc'),
      import('#/editor/model/ids'),
    ])
    const meta = await insertProject(emptyDocument(genId('doc'), name))
    return ok({
      id: meta.id,
      name: meta.name,
      hint: `Open /p/${meta.id} in the Canvazz app (default http://localhost:47823) to edit it.`,
    })
  } catch (err) {
    return fail(err)
  }
})

// --- Context first ----------------------------------------------------------

server.registerTool('get_basic_info', {
  title: 'Get document overview',
  description:
    'CALL BEFORE EDITING A PROJECT. Returns document/page info, artboards with world rects, components, tokens, selection, camera, and usage hints.',
  inputSchema: { project },
}, forward('get_basic_info'))

server.registerTool('get_selection', {
  title: 'Get current selection',
  description: 'Node ids and summaries of what the user has selected on canvas right now.',
  inputSchema: { project },
}, forward('get_selection'))

server.registerTool('get_tree_summary', {
  title: 'Get layer tree summary',
  description:
    'Compact indented tree (id, name, tag, size, position) for the page or a subtree. Cheap — prefer this over get_html for orientation.',
  inputSchema: {
    project,
    rootId: z.string().optional().describe('Limit to this subtree'),
    depth: z.number().int().min(1).max(8).optional().describe('Max depth (default 4)'),
  },
}, forward('get_tree_summary'))

server.registerTool('get_children', {
  title: 'List direct children',
  description: 'Summaries of a node’s direct children, in z-order (last = front).',
  inputSchema: { project, id },
}, forward('get_children'))

server.registerTool('get_node_info', {
  title: 'Get full node detail',
  description: 'Full model of one node: tag, attrs, inline styles, classes, text, rect, parent/children summaries.',
  inputSchema: { project, id },
}, forward('get_node_info'))

server.registerTool('get_html', {
  title: 'Read node as HTML',
  description: 'Exact sanitized HTML of a subtree (instances expanded), with data-cz-id/name for stable identity.',
  inputSchema: { project, id },
}, forward('get_html'))

server.registerTool('get_jsx', {
  title: 'Read node as JSX',
  description: 'The subtree as a React component (className + camelCase style objects).',
  inputSchema: { project, id },
}, forward('get_jsx'))

server.registerTool('get_computed_styles', {
  title: 'Get computed styles',
  description: 'Browser-computed CSS for a node (what actually renders, after Tailwind/inheritance/layout).',
  inputSchema: {
    project,
    id,
    properties: z.array(z.string()).optional().describe('Specific CSS properties; default returns a useful set'),
  },
}, forward('get_computed_styles'))

server.registerTool('get_screenshot', {
  title: 'Screenshot artboard or node',
  description: 'PNG of a node or the first artboard. Use to visually verify your edits.',
  inputSchema: { project, id: z.string().optional().describe('Node/artboard id; default first artboard') },
}, forward('get_screenshot', 45_000))

server.registerTool('insert_icon', {
  title: 'Insert an SF Symbol icon',
  description:
    'Place one of 7,007 Apple SF Symbols on the canvas as editable vector nodes. Address by Apple name ("heart.fill", "pills.fill", "wind", "lungs"). Color via the color arg or restyle later (CSS color / currentColor).',
  inputSchema: {
    project,
    name: z.string().min(1).describe('SF Symbol name, e.g. "cross.case.fill"'),
    variant: z.enum(['monochrome', 'dualtone']).optional().describe('Default monochrome'),
    size: z.number().optional().describe('Pixel size, default 24'),
    targetId: z.string().optional().describe('Container node; default page level'),
    x: z.number().optional(), y: z.number().optional(),
    color: z.string().optional().describe('CSS color for the glyph'),
    index: z.number().int().optional(),
  },
}, forward('insert_icon', 30_000))

server.registerTool('create_page', {
  title: 'Create a page',
  description: 'Add a new page to the document and switch to it.',
  inputSchema: { project, name: z.string().min(1).max(60) },
}, forward('create_page'))

server.registerTool('open_page', {
  title: 'Switch the visible page',
  description: 'Open a page by id or name (see get_basic_info → pages); name matching is case-insensitive. Artboards you create land on the active page.',
  inputSchema: { project, page: z.string().min(1).describe('Page id or name (name match is case-insensitive)') },
}, forward('open_page'))

server.registerTool('rename_page', {
  title: 'Rename a page',
  description: 'Rename a page (by id or case-insensitive name). The hidden Design System page cannot be renamed.',
  inputSchema: {
    project,
    page: z.string().min(1).describe('Page id or name (name match is case-insensitive)'),
    name: z.string().min(1).max(60),
  },
}, forward('rename_page'))

server.registerTool('delete_page', {
  title: 'Delete a page',
  description:
    'Delete a page and all its contents (by id or case-insensitive name). Refuses to delete the only user page or the hidden Design System page. Undoable.',
  inputSchema: { project, page: z.string().min(1).describe('Page id or name (name match is case-insensitive)') },
}, forward('delete_page'))

server.registerTool('set_tokens', {
  title: 'Set color/design tokens',
  description:
    'Define or remove document tokens (CSS custom properties on the canvas root). Reference them anywhere as var(--name); editing a token recolors every usage instantly.',
  inputSchema: {
    project,
    set: z.record(z.string(), z.string().nullable()).describe('e.g. {"brand": "#0A9BFF", "old-token": null}'),
  },
}, forward('set_tokens'))

server.registerTool('get_fonts', {
  title: 'List available fonts',
  description: 'Document fonts (loaded from Google Fonts) plus safe builtin families.',
  inputSchema: { project },
}, forward('get_fonts'))

server.registerTool('add_font', {
  title: 'Add a Google font',
  description:
    'Load a Google Fonts family into the document (undoable). Returns loaded=false if the family does not exist.',
  inputSchema: {
    project,
    family: z.string().min(1).max(60).describe('e.g. "Space Grotesk"'),
    weights: z.array(z.number()).optional().describe('Default [400, 500, 600, 700]'),
  },
}, forward('add_font', 30_000))

// --- Targeted edits ---------------------------------------------------------

server.registerTool('create_artboard', {
  title: 'Create artboard',
  description: 'New top-level artboard (a real DOM container) at world coordinates.',
  inputSchema: {
    project,
    name: z.string().optional(),
    x: z.number().optional(), y: z.number().optional(),
    width: z.number().min(1).optional().describe('Default 375'),
    height: z.number().min(1).optional().describe('Default 667'),
  },
}, forward('create_artboard'))

server.registerTool('write_html', {
  title: 'Write HTML to the canvas',
  description:
    'Insert or replace real HTML/CSS/Tailwind, including a sanitized SVG subset (svg/path/circle/rect/gradients — use/foreignObject/external refs are stripped). Sanitized (scripts/handlers/unsafe CSS stripped — strip reasons returned), parsed into the model, and rendered live. Prefer several small writes over one giant one so the user sees progress. Use style="position:absolute; left/top" for free placement inside artboards, or flex containers for auto-layout.',
  inputSchema: {
    project,
    html: z.string().min(1).describe('HTML fragment. data-cz-name sets layer names.'),
    targetId: z.string().optional().describe('Container (insert into) or reference node (before/after/replace)'),
    mode: z.enum(['insert', 'before', 'after', 'replace']).optional().describe('Default insert (append into targetId or page)'),
    index: z.number().int().optional().describe('Child index for insert mode'),
  },
}, forward('write_html'))

server.registerTool('update_styles', {
  title: 'Update inline styles',
  description:
    'Set/remove inline CSS on specific nodes. Batched into one undoable transaction. Use kebab-case props; null removes. Rejected (unsafe/unknown) props are reported.',
  inputSchema: {
    project,
    updates: z.array(z.object({
      id: z.string(),
      set: z.record(z.string(), z.string().nullable()).describe('e.g. {"background-color": "#fff", "padding": null}'),
    })).min(1),
  },
}, forward('update_styles'))

server.registerTool('set_classes', {
  title: 'Set Tailwind classes',
  description: 'Replace a node’s class list (validated; dangerous tokens dropped).',
  inputSchema: { project, id, classes: z.string().describe('Space-separated class string') },
}, forward('set_classes'))

server.registerTool('set_text_content', {
  title: 'Set text content',
  description: 'Replace a node’s text. Works on headings, paragraphs, spans, buttons, etc.',
  inputSchema: { project, id, text: z.string() },
}, forward('set_text_content'))

server.registerTool('move_nodes', {
  title: 'Move / reparent nodes',
  description: 'Change parent, z-order index, and/or absolute x/y position (px, relative to parent).',
  inputSchema: {
    project,
    moves: z.array(z.object({
      id: z.string(),
      parentId: z.string().optional().describe('New parent (omit to keep)'),
      index: z.number().int().optional().describe('Child index / z-order'),
      x: z.number().optional(), y: z.number().optional(),
    })).min(1),
  },
}, forward('move_nodes'))

server.registerTool('duplicate_nodes', {
  title: 'Duplicate nodes',
  description: 'Deep-copies subtrees (fresh ids), returns the new ids.',
  inputSchema: { project, ids: z.array(z.string()).min(1), offset: z.number().optional().describe('px offset, default 16') },
}, forward('duplicate_nodes'))

server.registerTool('delete_nodes', {
  title: 'Delete nodes',
  description: 'Remove subtrees. Undoable like every other edit.',
  inputSchema: { project, ids: z.array(z.string()).min(1) },
}, forward('delete_nodes'))

server.registerTool('set_visibility', {
  title: 'Show/hide layers',
  description: 'Toggle node visibility (the layer eye, not display CSS — instance overrides can re-show hidden definition nodes).',
  inputSchema: {
    project,
    updates: z.array(z.object({ id: z.string(), visible: z.boolean() })).min(1),
  },
}, forward('set_visibility'))

server.registerTool('rename_nodes', {
  title: 'Rename layers',
  description: 'Set human-readable layer names (keep them meaningful — they round-trip to code).',
  inputSchema: { project, renames: z.array(z.object({ id: z.string(), name: z.string().min(1) })).min(1) },
}, forward('rename_nodes'))

// --- Components -------------------------------------------------------------

server.registerTool('create_component', {
  title: 'Create component from node',
  description: 'Turn a subtree into a main component. Instances stay linked and update when it changes.',
  inputSchema: { project, nodeId: z.string(), name: z.string().optional() },
}, forward('create_component'))

server.registerTool('create_variant', {
  title: 'Add component variant',
  description: 'Clone a component as a named variant (e.g. "hover", "dark") in its component set.',
  inputSchema: { project, componentId: z.string(), name: z.string().min(1) },
}, forward('create_variant'))

server.registerTool('create_instance', {
  title: 'Place a component instance',
  description: 'Insert a linked instance of a component at x/y (px, relative to parentId or the page).',
  inputSchema: {
    project,
    componentId: z.string(),
    parentId: z.string().optional().describe('Container node; default page level'),
    x: z.number().optional(), y: z.number().optional(),
  },
}, forward('create_instance'))

server.registerTool('detach_instance', {
  title: 'Detach an instance',
  description: 'Replace an instance with plain editable nodes (what it currently renders as).',
  inputSchema: { project, instanceId: z.string() },
}, forward('detach_instance'))

server.registerTool('delete_component', {
  title: 'Delete a component or variant',
  description:
    'Remove a component definition and its Design System subtree. Refuses while instances depend on it; instances switched to a deleted variant fall back to the base.',
  inputSchema: { project, componentId: z.string().min(1) },
}, forward('delete_component'))

server.registerTool('set_instance_overrides', {
  title: 'Override a component instance',
  description:
    'Per-instance overrides keyed by definition-node id: text, style, classes, visible, attrs, or nested swap (componentId/variantId). Also switches the instance variant via variantId at the top level.',
  inputSchema: {
    project,
    instanceId: z.string(),
    variantId: z.string().optional().describe('Switch the instance to this variant'),
    overrides: z.record(z.string(), z.object({
      text: z.string().optional(),
      style: z.record(z.string(), z.string()).optional(),
      classes: z.array(z.string()).optional(),
      visible: z.boolean().optional(),
      attrs: z.record(z.string(), z.string()).optional(),
      componentId: z.string().optional(),
      variantId: z.string().optional(),
    })).optional(),
  },
}, forward('set_instance_overrides'))

// --- Workflow ---------------------------------------------------------------

server.registerTool('select_nodes', {
  title: 'Select nodes on canvas',
  description: 'Highlight nodes for the user (e.g. what you just changed).',
  inputSchema: { project, ids: z.array(z.string()) },
}, forward('select_nodes'))

server.registerTool('export', {
  title: 'Export node as code',
  description: 'Production HTML or JSX for a subtree. Lossless: re-importable with identical structure.',
  inputSchema: { project, id, format: z.enum(['html', 'jsx']).optional() },
}, forward('export'))

server.registerTool('undo', {
  title: 'Undo last edit',
  description: 'Revert the most recent transaction (yours or the user’s — check the log via finish first if unsure).',
  inputSchema: { project },
}, forward('undo'))

server.registerTool('finish', {
  title: 'Finish the task',
  description:
    'CALL WHEN DONE. Clears AI change indicators, returns the recent edit log and document stats. Provide a one-line summary of what you did.',
  inputSchema: { project, summary: z.string().optional() },
}, forward('finish'))

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: async ({ request }) => handleMcpRequest(request, server),
    },
  },
})
