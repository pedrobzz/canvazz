# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It drives
Canvazz's versioning and `CHANGELOG.md`.

## Adding a changeset to your PR

Every PR that changes behavior should include a changeset:

```sh
bun run changeset
```

Pick the bump and write a one-line, user-facing summary:

- **patch** — bug fixes, internal changes with no API impact
- **minor** — new, backwards-compatible features
- **major** — breaking changes

This writes a small markdown file here; commit it with your PR. CI checks that a changeset is
present.

For PRs that need **no release** (docs, CI, chores), add an empty changeset:

```sh
bun run changeset -- --empty
```

## How releases happen

On merge to `main`, a bot opens/updates a **"Version Packages"** PR that consumes the pending
changesets, bumps `package.json`, and updates `CHANGELOG.md`. Merging that PR cuts a GitHub
Release with the standalone `darwin-arm64` binary. You never bump the version by hand.
