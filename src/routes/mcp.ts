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
