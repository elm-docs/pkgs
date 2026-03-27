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
npm run sync            # Sync packages from registry
npm run sync-github     # Sync GitHub metadata (stars, issues, PRs, commits)
npm run build-db        # Build SQLite database from synced data
npm run type-search     # Search by type signature (e.g. "List a -> Maybe a")
npm run status          # Report sync status
npm run elm:test        # Run Elm tests
npm run elm:status      # Run Elm status script
```

## Architecture

Four subsystems, each in its own directory:

### `package-elm-lang-org/` — Package Sync

Downloads docs.json files from the Elm package registry and GitHub metadata. Synced content lives in `package-elm-lang-org/content/packages/{org}/{pkg}/{version}/`.

- `sync.ts` — Discovery and parallel download of docs.json
- `syncGithub.ts` — GitHub API interaction with rate-limit handling, redirect detection
- `status.ts` — Reports package states: success / pending / error / missing
- Each package version directory may contain: `docs.json`, `errors.json`, `pending`, `github.json`, `github-redirect.json`, `github-missing.json`

### `db/` — Database Builder

Builds a SQLite database (WAL mode) from synced docs and GitHub data. Supports incremental builds via file-change tracking.

- `db.ts` — Schema: packages, modules, values, unions, aliases, binops, github, type_index, search_index (FTS5)
- `ingest.ts` — Parses docs.json and github*.json into the database
- `typeIndex.ts` — Builds searchable type signature index with fingerprints

### `type-search/` — Type Signature Search

Finds Elm functions by type signature using a penalty-based distance metric (inspired by elm-search).

- Pipeline: parse query → normalize variables → generate fingerprint → pre-filter candidates → try argument permutations → rank by distance with package priority boosts (elm/core > elm/* > elm-community/*)
- See `type-search/README.md` for algorithm details

### `scripts/` — Elm Status Script

Pure Elm implementation of status reporting using elm-pages. Business logic is mutation-tested.

- `src/Status/Classification.elm` — Classifies packages by sync state
- `src/Shared/PackageVersion.elm` — Package version parsing
- Tests in `scripts/tests/`

## Language Split

- **TypeScript** (strict mode, ESNext, NodeNext): sync tools, database builder, type search
- **Elm**: status script and its pure business logic, with elm-test-rs for testing
