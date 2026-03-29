# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A system for syncing, indexing, and searching all published Elm packages. It downloads documentation from package.elm-lang.org, fetches GitHub metadata, builds a SQLite database with full-text and type-signature search, and monitors sync health. CI syncs every 15 minutes.

## Development Environment

Claude is expected to be launched inside a `nix develop` shell, which provides all required tools (Node 22, Elm compiler, elm-test-rs, elm-format, TypeScript, etc.). Do **not** use `npx` or `nix develop --command` — commands should be run directly.

**If tools are missing:** Warn the user that Claude does not appear to be running inside the Nix shell and ask them to relaunch Claude from within `nix develop`.

**If `flake.nix` changes during a session:** Re-enter the Nix shell by running `nix develop` to pick up the updated environment before running further commands.

## Common Commands

```bash
npm run test              # Run Elm tests
npm run status            # Report sync status
npm run sync              # Orchestrated sync: SyncElmPackages then SyncGithub
npm run sync-elm-packages # Sync packages from registry (docs.json)
npm run sync-github       # Sync GitHub metadata
npm run build-db          # Build SQLite database from synced data
npm run type-search       # Search by type signature (e.g. "List a -> Maybe a")

# CLI dispatcher (lazily builds DB, routes to Elm scripts)
node bin/elm-docs.mjs help
node bin/elm-docs.mjs type-search 'List a -> Maybe a'
node bin/elm-docs.mjs build-db
node bin/elm-docs.mjs status
```

## Architecture

All CLI tools are implemented in Elm using elm-pages scripts, located in `scripts/src/`. Node.js FFI for SQLite and filesystem operations is provided by `scripts/custom-backend-task.ts` — the only TypeScript file in the project.

### `scripts/` — CLI Tools (Elm + elm-pages)

All CLI tool source code lives here:
- `src/Sync.elm` — Orchestrator: runs SyncElmPackages then SyncGithub sequentially
- `src/SyncElmPackages.elm` — Discovery and parallel download of docs.json from the Elm package registry
- `src/SyncGithub.elm` — GitHub API interaction with rate-limit handling, redirect detection
- `src/Status.elm` — Reports package states: success / pending / error / missing
- `src/BuildDb.elm` — Builds SQLite database from synced docs and GitHub data
- `src/TypeSearch.elm` — Finds Elm functions by type signature using distance metrics
- `custom-backend-task.ts` — Node.js/SQLite FFI bridge for elm-pages (the sole TS file)
- Tests in `scripts/tests/`

### `package-elm-lang-org/` — Synced Content

Contains synced package data (not source code). Each package version directory may contain: `docs.json`, `errors.json`, `pending`, `github.json`, `github-redirect.json`, `github-missing.json`.

### `db/` — Database

Default location for `elm-packages.db` (SQLite). No source code.

### `type-search/` — Algorithm Documentation

Contains `README.md` documenting the type search algorithm. No source code.

### `bin/` — CLI Dispatcher

Contains `elm-docs.mjs`, a hand-written Node.js entry point that routes CLI actions to Elm scripts via `elm-pages run`. Handles lazy DB creation for `type-search`.

## Commit Guidelines

- Do **not** add `Co-Authored-By` trailers to commit messages. Commits should be authored solely by the human user.
