---
name: design-to-code
description: Turn a Canvazz design into production code using the project's existing conventions.
---

# Design To Code From Canvazz

Use this skill when the user wants to implement a selected Canvazz artboard, frame, component, or node in the current codebase.

## Connection

Canvazz must already be running at `http://localhost:47823` with the target project open in a browser tab (`/p/<project-id>`). The MCP endpoint is `http://localhost:47823/mcp` and the configured MCP server name is `canvazz`.

Canvazz is multi-project: every canvas tool requires a `project` argument (project id or exact name). Call `list_projects` first to discover ids and see which projects are open in a live editor tab — only open projects can be read.

Do not start the development server unless the user explicitly asks. If MCP calls fail with no live bridge for the project, tell the user to open that project in the browser and keep the tab open.

## Required Workflow

1. Call `list_projects` to pick the target project, then `get_basic_info` (with `project`) before any other Canvazz MCP tool.
2. Determine the implementation target:
   - Use `get_selection` first. If nothing useful is selected, use `get_tree_summary` to find the intended artboard or node.
   - Use `get_children` and `get_node_info` to understand structure without pulling excessive HTML.
3. Read exact source data only after orientation:
   - Use `get_html` or `get_jsx` for the selected subtree.
   - Use `get_computed_styles` for values that must match browser-rendered output.
   - Use `get_screenshot` to verify visual intent and catch layout details that structure alone does not show.
4. Inspect the repo's implementation conventions:
   - Routing, component boundaries, styling approach, shared UI primitives, icon libraries, token usage, tests, and naming patterns.
   - Implement with the existing framework and conventions. Do not introduce a new styling system or abstraction unless the repo already points there.
5. Translate Canvazz output into production code:
   - Keep semantic structure where possible.
   - Convert inline styles into the project's preferred classes, tokens, CSS modules, or component props.
   - Preserve text content, layout, spacing, typography, color, and responsive behavior.
   - Use exported JSX/HTML as source material, not as unreviewed paste-in production code.
6. If design ambiguity blocks a correct implementation, use targeted MCP reads before asking the user.
7. After code edits, run the narrowest relevant checks available in the repo. Do not start a dev server unless the user explicitly permits it.
8. If you modified the Canvazz canvas during the workflow, call `finish` with a one-line summary.

## Canvazz MCP Notes

The Canvazz model round-trips HTML/CSS/Tailwind through stable `data-cz-id` and `data-cz-name` attributes. Component instances may expose override data keyed by definition-node ids, so inspect instance details before flattening repeated UI. Canvazz exports are intentionally re-importable; production code should still be adapted to the repo's own component structure.
