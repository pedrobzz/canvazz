# canvazz

## 0.2.0

### Minor Changes

- 4853e8e: Add an automated release pipeline. Versioning is now Changesets-driven; every PR runs CI
  (typecheck + unit + Playwright e2e) and must include a changeset. Merging the resulting
  "Version Packages" PR publishes a standalone **darwin-arm64 (Apple Silicon)** binary to GitHub
  Releases, installable and self-updating via `curl -fsSL .../install.sh | sh`.
