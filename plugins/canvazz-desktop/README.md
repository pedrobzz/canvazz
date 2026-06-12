# Canvazz Desktop

Canvazz Desktop lets Codex and Claude Code work directly with a live Canvazz canvas through the app's built-in MCP endpoint.

## What It Does

- Reads the active document, selection, layer tree, node details, HTML, JSX, computed styles, fonts, and screenshots.
- Writes sanitized HTML, CSS, Tailwind classes, and SVG subsets onto the canvas.
- Performs targeted edits for styles, text, classes, movement, duplication, visibility, pages, tokens, fonts, SF Symbols, and components.
- Exports selected nodes as production HTML or JSX.

## Prerequisites

Canvazz must already be running at `http://localhost:47823`, and the editor must be open in a browser tab. The MCP endpoint forwards tool calls to that live tab over the app's SSE bridge, so the browser is the execution environment.

Manual MCP connection:

```sh
claude mcp add --transport http canvazz http://localhost:47823/mcp
```

Do not start the Canvazz development server from an agent unless the user explicitly asks for it.

## Skills

- `code-to-design`: Generate a Canvazz design from the project's codebase.
- `design-to-code`: Turn a Canvazz design into production code using the project's conventions.
