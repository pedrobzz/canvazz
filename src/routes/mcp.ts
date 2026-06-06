// Side-effect import: registers the `server.handlers` route-option module
// augmentation from @tanstack/start-client-core.
import '@tanstack/react-start'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handleMcpRequest } from '#/utils/mcp-handler'
import { dispatchToEditor } from '#/server/bridge'

/**
 * Canvazz MCP server. Paper-style contract: gather context first
 * (get_basic_info / get_tree_summary), make incremental visible writes,
 * read exactly what you need, edit specific nodes, and call finish when done.
 * Every mutation is transactional, undoable, sanitized, and returns changed
 * node ids plus summaries so follow-up reads are rarely needed.
 *
 * Connect: claude mcp add --transport http canvazz http://localhost:3000/mcp
 */

const server = new McpServer({ name: 'canvazz', version: '1.0.0' })

const id = z.string().describe('Node id (from get_tree_summary / get_basic_info)')

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  isError?: boolean
}

function forward(tool: string, timeoutMs = 20_000) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await dispatchToEditor(tool, args ?? {}, timeoutMs)
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  }
}

// --- Context first ----------------------------------------------------------

server.registerTool('get_basic_info', {
  title: 'Get document overview',
  description:
    'ALWAYS CALL FIRST. Returns document/page info, artboards with world rects, components, tokens, selection, camera, and usage hints.',
  inputSchema: {},
}, forward('get_basic_info'))

server.registerTool('get_selection', {
  title: 'Get current selection',
  description: 'Node ids and summaries of what the user has selected on canvas right now.',
  inputSchema: {},
}, forward('get_selection'))

server.registerTool('get_tree_summary', {
  title: 'Get layer tree summary',
  description:
    'Compact indented tree (id, name, tag, size, position) for the page or a subtree. Cheap — prefer this over get_html for orientation.',
  inputSchema: {
    rootId: z.string().optional().describe('Limit to this subtree'),
    depth: z.number().int().min(1).max(8).optional().describe('Max depth (default 4)'),
  },
}, forward('get_tree_summary'))

server.registerTool('get_children', {
  title: 'List direct children',
  description: 'Summaries of a node’s direct children, in z-order (last = front).',
  inputSchema: { id },
}, forward('get_children'))

server.registerTool('get_node_info', {
  title: 'Get full node detail',
  description: 'Full model of one node: tag, attrs, inline styles, classes, text, rect, parent/children summaries.',
  inputSchema: { id },
}, forward('get_node_info'))

server.registerTool('get_html', {
  title: 'Read node as HTML',
  description: 'Exact sanitized HTML of a subtree (instances expanded), with data-cz-id/name for stable identity.',
  inputSchema: { id },
}, forward('get_html'))

server.registerTool('get_jsx', {
  title: 'Read node as JSX',
  description: 'The subtree as a React component (className + camelCase style objects).',
  inputSchema: { id },
}, forward('get_jsx'))

server.registerTool('get_computed_styles', {
  title: 'Get computed styles',
  description: 'Browser-computed CSS for a node (what actually renders, after Tailwind/inheritance/layout).',
  inputSchema: {
    id,
    properties: z.array(z.string()).optional().describe('Specific CSS properties; default returns a useful set'),
  },
}, forward('get_computed_styles'))

server.registerTool('get_screenshot', {
  title: 'Screenshot artboard or node',
  description: 'PNG of a node or the first artboard. Use to visually verify your edits.',
  inputSchema: { id: z.string().optional().describe('Node/artboard id; default first artboard') },
}, forward('get_screenshot', 45_000))

// --- Targeted edits ---------------------------------------------------------

server.registerTool('create_artboard', {
  title: 'Create artboard',
  description: 'New top-level artboard (a real DOM container) at world coordinates.',
  inputSchema: {
    name: z.string().optional(),
    x: z.number().optional(), y: z.number().optional(),
    width: z.number().min(1).optional().describe('Default 375'),
    height: z.number().min(1).optional().describe('Default 667'),
  },
}, forward('create_artboard'))

server.registerTool('write_html', {
  title: 'Write HTML to the canvas',
  description:
    'Insert or replace real HTML/CSS/Tailwind. It is sanitized (scripts/handlers/unsafe CSS stripped — strip reasons returned), parsed into the model, and rendered live. Prefer several small writes over one giant one so the user sees progress. Use style="position:absolute; left/top" for free placement inside artboards, or flex containers for auto-layout.',
  inputSchema: {
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
    updates: z.array(z.object({
      id: z.string(),
      set: z.record(z.string(), z.string().nullable()).describe('e.g. {"background-color": "#fff", "padding": null}'),
    })).min(1),
  },
}, forward('update_styles'))

server.registerTool('set_classes', {
  title: 'Set Tailwind classes',
  description: 'Replace a node’s class list (validated; dangerous tokens dropped).',
  inputSchema: { id, classes: z.string().describe('Space-separated class string') },
}, forward('set_classes'))

server.registerTool('set_text_content', {
  title: 'Set text content',
  description: 'Replace a node’s text. Works on headings, paragraphs, spans, buttons, etc.',
  inputSchema: { id, text: z.string() },
}, forward('set_text_content'))

server.registerTool('move_nodes', {
  title: 'Move / reparent nodes',
  description: 'Change parent, z-order index, and/or absolute x/y position (px, relative to parent).',
  inputSchema: {
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
  inputSchema: { ids: z.array(z.string()).min(1), offset: z.number().optional().describe('px offset, default 16') },
}, forward('duplicate_nodes'))

server.registerTool('delete_nodes', {
  title: 'Delete nodes',
  description: 'Remove subtrees. Undoable like every other edit.',
  inputSchema: { ids: z.array(z.string()).min(1) },
}, forward('delete_nodes'))

server.registerTool('rename_nodes', {
  title: 'Rename layers',
  description: 'Set human-readable layer names (keep them meaningful — they round-trip to code).',
  inputSchema: { renames: z.array(z.object({ id: z.string(), name: z.string().min(1) })).min(1) },
}, forward('rename_nodes'))

// --- Components -------------------------------------------------------------

server.registerTool('create_component', {
  title: 'Create component from node',
  description: 'Turn a subtree into a main component. Instances stay linked and update when it changes.',
  inputSchema: { nodeId: z.string(), name: z.string().optional() },
}, forward('create_component'))

server.registerTool('create_variant', {
  title: 'Add component variant',
  description: 'Clone a component as a named variant (e.g. "hover", "dark") in its component set.',
  inputSchema: { componentId: z.string(), name: z.string().min(1) },
}, forward('create_variant'))

server.registerTool('set_instance_overrides', {
  title: 'Override a component instance',
  description:
    'Per-instance overrides keyed by definition-node id: text, style, classes, visible, attrs, or nested swap (componentId/variantId). Also switches the instance variant via variantId at the top level.',
  inputSchema: {
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
  inputSchema: { ids: z.array(z.string()) },
}, forward('select_nodes'))

server.registerTool('export', {
  title: 'Export node as code',
  description: 'Production HTML or JSX for a subtree. Lossless: re-importable with identical structure.',
  inputSchema: { id, format: z.enum(['html', 'jsx']).optional() },
}, forward('export'))

server.registerTool('undo', {
  title: 'Undo last edit',
  description: 'Revert the most recent transaction (yours or the user’s — check the log via finish first if unsure).',
  inputSchema: {},
}, forward('undo'))

server.registerTool('finish', {
  title: 'Finish the task',
  description:
    'CALL WHEN DONE. Clears AI change indicators, returns the recent edit log and document stats. Provide a one-line summary of what you did.',
  inputSchema: { summary: z.string().optional() },
}, forward('finish'))

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: async ({ request }) => handleMcpRequest(request, server),
    },
  },
})
