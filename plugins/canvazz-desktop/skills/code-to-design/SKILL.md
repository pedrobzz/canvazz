---
name: code-to-design
description: Generate a Canvazz design from the project's codebase using Canvazz's integrated MCP tools.
---

# Code To Design In Canvazz

Use this skill when the user wants to create, push, or adapt an application screen, component, design system, or UI concept onto the Canvazz canvas from the current codebase.

## Connection

Canvazz must already be running at `http://localhost:47823` with the target project open in a browser tab (`/p/<project-id>`). The MCP endpoint is `http://localhost:47823/mcp` and the configured MCP server name is `canvazz`.

Canvazz is multi-project: every canvas tool requires a `project` argument (project id or exact name). Call `list_projects` first to discover ids and see which projects are open in a live editor tab — only open projects can be read or edited. Use `create_project` to start a new empty project, then ask the user to open `/p/<id>`.

Do not start the development server unless the user explicitly asks. If MCP calls fail with no live bridge for the project, tell the user to open that project in the browser and keep the tab open.

## Required Workflow

1. Call `list_projects` to pick the target project, then `get_basic_info` (with `project`) before any other Canvazz MCP tool.
2. Read the project's real styling context before designing:
   - CSS, Tailwind configuration, component primitives, theme files, typography, tokens, and existing UI patterns.
   - Prefer repo conventions over generic defaults.
3. Use `get_fonts` before choosing a non-system typeface. Use `add_font` only when a Google Font is needed for the design.
4. Create or choose the destination:
   - Use `create_page` for a distinct new design direction.
   - Use `create_artboard` for new screens.
   - Use `open_page`, `get_tree_summary`, or `get_selection` when adding to existing work.
5. Write incrementally with `write_html` so the user can see progress:
   - Build roughly one meaningful visual group per call.
   - Use `data-cz-name` for useful layer names.
   - Use stable `data-cz-id` only when you need later targeted edits.
   - Prefer real HTML/CSS layout. Use SVG only for vector marks, icons, charts, or shapes that need it.
6. Use targeted edit tools instead of rewriting large subtrees:
   - `update_styles`, `set_classes`, `set_text_content`, `move_nodes`, `duplicate_nodes`, `rename_nodes`, `set_visibility`.
   - Use `set_tokens` for shared color/design tokens and reference them with `var(--token-name)`.
   - Use `insert_icon` for Apple SF Symbols when an icon exists instead of hand-drawing common glyphs.
7. For reusable UI, create components deliberately:
   - `create_component` for a finished subtree.
   - `create_variant`, `create_instance`, and `set_instance_overrides` for component sets and instances.
8. Verify meaningful changes with `get_screenshot`.
9. Call `finish` with a one-line summary when done.

## Canvazz MCP Notes

The Canvazz canvas is DOM-native: layers are sanitized HTML elements styled with CSS and Tailwind classes. Every MCP mutation is transactional, undoable, schema-validated, and returns changed ids plus summaries. Unsafe markup, event handlers, scripts, iframes, unsafe URLs, and rejected CSS are reported in `dropped` or `rejected` results.

Prefer this operating loop:

`list_projects` -> `get_basic_info` -> repo style reads -> `create_page`/`create_artboard` -> small `write_html` calls -> targeted edits -> `get_screenshot` -> `finish` (all with the same `project`).
