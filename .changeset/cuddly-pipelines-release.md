---
"canvazz": minor
---

Add an automated release pipeline. Versioning is now Changesets-driven; every PR runs CI
(typecheck + unit + Playwright e2e) and must include a changeset. Merging the resulting
"Version Packages" PR publishes a standalone **darwin-arm64 (Apple Silicon)** binary to GitHub
Releases, installable and self-updating via `curl -fsSL .../install.sh | sh`.
