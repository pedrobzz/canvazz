# Canvazz

An AI-first, DOM-native design editor in the spirit of [Paper](https://paper.design/) and
[Wonder](https://wonder.design/). The canvas is not a vector renderer with a code-export step —
**every layer is a real, sanitized HTML element styled with CSS**, laid out by the browser's
layout engine. Design and code are the same artifact, so they round-trip without translation
loss.

Stack: React 19 · TanStack Start · TypeScript (strict) · Tailwind CSS v4 · shadcn/ui.
Local-first (IndexedDB autosave), no backend required. Convex is intentionally not used —
it becomes relevant only if shared projects/multiplayer are added (see *Collaboration*).

## Run it

```sh
bun install
bun run dev          # http://localhost:3000
```

Connect an AI agent over MCP (Claude Code example):

```sh
claude mcp add --transport http canvazz http://localhost:3000/mcp
```

Keep the editor open in a browser — the MCP server forwards tool calls to the live tab over
SSE, so you watch the AI design in real time. Edits pulse purple on canvas, land in the
**Log** tab, and are undoable like any user edit.

```sh
bun run test         # unit: ops, sanitizer, round-trip (vitest + jsdom)
bun run test:e2e     # Playwright: interactions, MCP contract, visual, perf
bun run typecheck
```

## Architecture

```
src/editor/
  model/        Canonical document model + transactional ops
    types.ts      pages, nodes (tag/attrs/style/classes/text), components,
                  variants, overrides, tokens, assets, comments
    doc.ts        applyOps: pure, returns inverse ops → undo by construction
    instances.ts  instance expansion (definition + overrides → resolved tree)
    factory.ts    shapes as HTML: ellipse = border-radius, line = thin div,
                  polygon/star = clip-path, frame/artboard = real container
  compiler/     The bidirectional compiler
    allowlist.ts  single source of truth: tags, attrs, CSS props, URL and
                  class sanitization
    parse.ts      untrusted HTML/CSS/Tailwind → sanitized model (DOMParser)
    export.ts     model → HTML / JSX; stable ids and layer names round-trip
                  via data-cz-id / data-cz-name
  store/        External state (outside React)
    editorStore.ts per-node subscriptions, history, selection, command log
    persistence.ts IndexedDB autosave (debounced) + restore
  canvas/       The infinite canvas
    camera.ts     pan/zoom store; subscribers write transforms directly to DOM
    NodeView.tsx  model → live DOM; one React component per node
    overlay.ts    screen-space selection chrome — imperative, pooled, never
                  reflows content
    controller.ts pointer/keyboard state machine: select/marquee/drag/resize/
                  rotate/draw/pan, snapping, reparenting, shortcuts
    geometry.ts   DOMRect-derived geometry; the browser is the layout engine
  components/   Main components, variants, instances, overrides, detach
  ai/           MCP browser side
    aiTools.ts    tool executors (all mutations: transactional, source 'ai')
    bridgeClient.ts SSE bridge client
  commands.ts   Shared command layer (humans and AI both go through it)
src/server/bridge.ts        MCP→editor dispatch queue (SSE, in-memory)
src/routes/mcp.ts           MCP server: 27 tools, zod-validated
src/routes/api.bridge.*.ts  SSE stream + result callback
src/routes/perf.tsx         /perf?n=1000 — perf harness document generator
```

### The core invariants

1. **DOM-first.** No SVG/canvas shape renderer exists. Rectangles, ellipses, lines, text,
   frames are HTML elements with CSS (`border-radius`, `clip-path`, `transform`, flex, gap…).
   Geometry is always *derived* from the live DOM (`getBoundingClientRect`, computed styles,
   ResizeObserver/MutationObserver) — never duplicated in the model. Flexbox is the browser's.
2. **One write path.** Every mutation — keyboard, inspector, layer tree, MCP tool — is an
   `Op[]` applied through `applyOps`, which returns inverse ops. Transactions are atomic,
   undoable, logged, and tagged with their source (`user`/`ai`).
3. **Hot paths skip React.** Pan/zoom writes a transform to one element. Drags/resizes write
   `left/top/width/height` directly to the DOM and commit one transaction on pointer-up.
   The selection overlay is a pooled, imperative screen-space layer. React re-renders exactly
   the nodes whose model changed (per-node `useSyncExternalStore`).
4. **Everything is untrusted.** AI and pasted HTML pass the allowlist sanitizer (tags, attrs,
   URL schemes, CSS properties *and* values, Tailwind class tokens). Scripts, event handlers,
   `javascript:` URLs, iframes, remote `url()` loads, and CSS expressions are stripped and the
   strip reasons are reported back to the model.

### Round-tripping

`HTML/CSS/Tailwind → parse (sanitize) → model → live DOM → export HTML/JSX` preserves stable
node ids and layer names via `data-cz-id` / `data-cz-name`. Re-importing an export yields an
identical model (covered by unit tests). Mixed text/element content is normalized into spans
(visually identical, structurally explicit) — that is the only deliberate normalization.

Tailwind classes are first-class: stored on nodes, validated, exported as `class`/`className`,
and compiled at runtime by `@tailwindcss/browser` so AI-written utilities (including arbitrary
values like `top-[560px]`) paint immediately.

### Components

A main component is a flagged subtree living on canvas. Instances store only
`{ componentId, variantId, overrides }` and *derive* their DOM from the definition at render
time — component edits propagate to every instance immediately, while overrides (keyed by
definition-node id: text, style, classes, visibility, attrs, nested swaps) survive. Variants
are sibling definitions grouped in a component set. Detach materializes the resolved tree.
Instance internals are selectable on canvas (`instanceId:sourceId` path ids) and editable as
overrides from the inspector.

### MCP contract (Paper-style)

Context first → incremental visible writes → exact reads → targeted edits → explicit finish:

- **Reads:** `get_basic_info` (always first), `get_selection`, `get_tree_summary`,
  `get_children`, `get_node_info`, `get_html`, `get_jsx`, `get_computed_styles`,
  `get_screenshot` (PNG of any artboard/node).
- **Writes:** `create_artboard`, `write_html` (insert/before/after/replace),
  `update_styles`, `set_classes`, `set_text_content`, `move_nodes`, `duplicate_nodes`,
  `delete_nodes`, `rename_nodes`.
- **Components:** `create_component`, `create_instance`, `create_variant`,
  `set_instance_overrides`, `detach_instance`.
- **Workflow:** `select_nodes`, `export` (html/jsx), `undo`, `finish`.

Every mutation is schema-validated (zod), transactional, undoable, and returns changed ids
*plus* post-paint summaries (name, tag, live rect) so follow-up reads are rarely needed.
Rejected styles/markup come back as structured `dropped`/`rejected` lists.

## Security

- Allowlist sanitizer at every input boundary (see `compiler/allowlist.ts`); the model never
  stores an event handler, script, frame, or unsafe URL/CSS value.
- Untrusted markup is parsed with `DOMParser` (inert — scripts never execute) and rebuilt as
  model nodes; the canvas renders through React, never `innerHTML`.
- CSP meta blocks `object-src`/`frame-src`/`base-uri` hijacks. Production deployments should
  additionally send strict `script-src` + `require-trusted-types-for 'script'` headers (dev
  needs Vite's inline scripts, so this belongs at the host level).
- Interactive canvas elements (links, inputs) are rendered inert on the design surface.
- Image URLs: `https:`, same-origin paths, or base64 `data:image/*` only.

## Performance

Measured by the Playwright perf harness (`tests/e2e/perf.spec.ts`, headless Chromium):

- 1k-node document: ~80ms mount; click-to-paint selection ~76ms (INP budget ≤ 200ms);
  pan p75 well under 20ms/frame (camera writes bypass React).
- 10k-node document: ~400ms mount; selection still interactive (~400ms, generous smoke
  budget — layer tree/inspector rendering dominates, not the canvas).
- Artboards get `contain: layout style`; overlay work is rAF-batched and pooled.

## Testing

- `tests/unit/` — op inverses/atomicity, sanitizer (scripts/handlers/URLs/CSS/classes),
  HTML↔model↔HTML round-trips, JSX export, style conversion.
- `tests/e2e/editor.spec.ts` — select, marquee, drag (+undo/redo), resize, rotate, nudge,
  draw, in-place text editing, inspector edits, group/ungroup, copy/paste, layer tree
  (rename/lock/hide), zoom controls, the full component lifecycle, autosave-across-reload.
- `tests/e2e/mcp.spec.ts` — the live bridge: sanitized writes, round-trips, targeted edits,
  rejected dangerous CSS, component tools, screenshots, finish/cleanup.
- `tests/e2e/visual.spec.ts` — canvas screenshots at 50/100/200% zoom.
- `tests/e2e/perf.spec.ts` — 1k/10k documents, frame-time and INP-style budgets.

## Known limitations (deliberate v1 scope)

- `<style>` blocks in imported HTML are dropped — styling round-trips via inline styles and
  Tailwind classes.
- Comments render as pins with prompt-based editing — functional, not polished.
- No multiplayer. The transactional op log is CRDT-friendly; Convex + presence/cursors is the
  intended path if/when shared documents are needed.
- Visual diff for AI edits = change indicators + before/after via `get_screenshot`, not a
  pixel-diff gate.
