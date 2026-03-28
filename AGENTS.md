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
npm run status            # Report sync status (pre-built bundle)
npm run sync              # Sync packages from registry
npm run sync-github       # Sync GitHub metadata
npm run build-db          # Build SQLite database from synced data
npm run type-search       # Search by type signature (e.g. "List a -> Maybe a")

# Dev mode (runs via elm-pages run, slower but always up-to-date)
npm run status:dev
npm run sync:dev
npm run type-search:dev -- "List a -> Int"

# Build bundles (compiles Elm source into bin/*.mjs)
npm run status:build
npm run sync:build
npm run type-search:build
```

## Architecture

All CLI tools are implemented in Elm using elm-pages scripts, located in `scripts/src/`. Node.js FFI for SQLite and filesystem operations is provided by `scripts/custom-backend-task.ts` — the only TypeScript file in the project.

### `scripts/` — CLI Tools (Elm + elm-pages)

All CLI tool source code lives here:
- `src/Sync.elm` — Discovery and parallel download of docs.json from the Elm package registry
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

### `bin/` — Pre-built Bundles

Version-controlled `.mjs` bundles compiled from Elm sources. These are what the unprefixed `npm run` scripts execute.
