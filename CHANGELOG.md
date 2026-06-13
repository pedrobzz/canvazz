# canvazz

## 0.3.0

### Minor Changes

- a33cc23: Add comment threads. Pin a conversation to a node (hover-to-attach with the Comment tool, `C`)
  or drag a rectangle for an area comment attached to every node inside it. Each comment is a
  thread you can reply to, edit your latest message in, resolve, and reopen — with an Apple-style
  pin, hover popover, thread card, and a Comments tab listing Open/Resolved threads. The MCP agent
  is a participant via three new tools: `list_comments`, `get_comment`, and `reply_comment` (it
  reads the attached nodes, does the task and replies with a short confirmation that auto-resolves,
  or replies without resolving to ask a question / flag a blocker). Comments persist with the
  document but live outside the undo stack.

## 0.2.0

### Minor Changes

- 4853e8e: Add an automated release pipeline. Versioning is now Changesets-driven; every PR runs CI
  (typecheck + unit + Playwright e2e) and must include a changeset. Merging the resulting
  "Version Packages" PR publishes a standalone **darwin-arm64 (Apple Silicon)** binary to GitHub
  Releases, installable and self-updating via `curl -fsSL .../install.sh | sh`.
