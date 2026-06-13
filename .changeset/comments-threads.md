---
"canvazz": minor
---

Add comment threads. Pin a conversation to a node (hover-to-attach with the Comment tool, `C`)
or drag a rectangle for an area comment attached to every node inside it. Each comment is a
thread you can reply to, edit your latest message in, resolve, and reopen — with an Apple-style
pin, hover popover, thread card, and a Comments tab listing Open/Resolved threads. The MCP agent
is a participant via three new tools: `list_comments`, `get_comment`, and `reply_comment` (it
reads the attached nodes, does the task and replies with a short confirmation that auto-resolves,
or replies without resolving to ask a question / flag a blocker). Comments persist with the
document but live outside the undo stack.
