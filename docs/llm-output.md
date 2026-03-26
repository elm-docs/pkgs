# Plan: Generate llms.txt for Elm Package Ecosystem

## Context

LLMs working with Elm need a way to discover packages, understand APIs, and find solutions for high-level tasks ("I need JSON parsing", "I need an SPA router"). The [llms.txt](https://llmstxt.org/) standard defines a markdown-based format for making site knowledge LLM-accessible.

Our elm-docs database has ~2,017 Elm packages with full documentation (modules, functions, types, type signatures, comments) and GitHub metadata (stars, commit recency, issue health). Currently this is CLI-only with no web-facing output. The `package_tags` table exists in the schema but is empty.

**Goal**: Add a static generation build step that produces llms.txt files from the database, organized by category, so LLMs can efficiently find and understand Elm packages.

## Output Files

```
llms-txt/out/
  llms.txt              # Overview + categorized package links (~15 KB)
  llms-full.txt         # Same structure, summaries + key APIs inline (~300 KB)
  packages/
    elm/core.md         # Full API docs per package
    elm/json.md
    mdgriffith/elm-ui.md
    ...                 # ~2,000 files, all packages with docs
```

### llms.txt Format

```markdown
# Elm Packages

> Index of the Elm package ecosystem. Elm is a functional language that
> compiles to JavaScript, focused on reliability. Covers {N} packages.

## How to Use This Index

- Browse categories below to find packages by use case
- Each link points to a detailed markdown file with full API documentation
- Type signatures use Elm syntax: `a -> b` means a function from a to b

## Core & Language

Essential packages from the Elm core team.

- [elm/core](packages/elm/core.md): Standard library — List, Maybe, Result, Dict, Task
- [elm/json](packages/elm/json.md): Encode and decode JSON values
- [elm/html](packages/elm/html.md): Fast HTML with virtual DOM diffing
...

## UI Frameworks & Styling

- [mdgriffith/elm-ui](packages/mdgriffith/elm-ui.md): Layout and style without CSS
...

## Optional

### Other Packages

- [author/pkg](packages/author/pkg.md): Summary
...
```

### llms-full.txt Format

Same structure but each package entry expanded inline:

```markdown
### elm/core (v1.0.5) — 1,234 stars

Elm's standard libraries.

**Modules**: Array, Basics, Char, Dict, List, Maybe, Platform, Result, Set, String, Task, Tuple

Key functions:
- `List.map : (a -> b) -> List a -> List b` — Apply a function to every element
- `Maybe.withDefault : a -> Maybe a -> a` — Extract with a default
...
```

### Per-package .md Format

```markdown
# elm/json

> Encode and decode JSON values

**Version**: 1.0.2 | **License**: BSD-3-Clause | **Stars**: 312
**Elm package**: https://package.elm-lang.org/packages/elm/json/latest/

## Json.Decode

{module comment, with @docs directives stripped}

### Types

#### Decoder a
{comment}

### Functions

#### decodeString : Decoder a -> String -> Result Error a
{comment}

...
```

## Decisions

- **Categorization**: Manual curation (categories.json) for top ~150 packages + keyword heuristic fallback for the rest
- **DB writes**: Also populate the `package_tags` table with category assignments so other tools can query by category
- **Output**: `llms-txt/out/` (gitignored), default location

## New Source Files

```
pkgs/llms-txt/
  generate.ts           # CLI entry point
  lib/
    categories.ts       # Load categories.json + heuristic fallback
    ranking.ts          # Score packages by stars/recency/health
    render.ts           # Pure functions: data → markdown strings
    queries.ts          # SQL queries against existing DB
    tags.ts             # Write category → package_tags table
  categories.json       # Curated category → package mapping
```

## Implementation Steps

### Step 1: `categories.json` — Curated category mapping

A JSON file with ~15-20 categories. Each category has an id, title, description, and list of package names. Covers the top ~150 packages manually. Categories:

- Core & Language (`elm/*` essentials)
- JSON & Serialization
- HTTP & Networking
- HTML & DOM
- UI Frameworks & Styling
- SVG & Graphics
- Navigation & Routing
- Parsing
- Data Structures
- Date & Time
- Testing
- Math & Numbers
- Animation
- Accessibility
- Ports & JavaScript Interop
- Markdown & Text
- Developer Tooling

Packages not in the curated list get classified by heuristic (keyword matching on name/summary/modules) or fall into "Other".

### Step 2: `lib/queries.ts` — Database queries

All SQL queries as functions taking a `Database` instance. Reuse the "latest version" subquery pattern from `db/lib/ingest.ts`:

- `getRankedPackages(db)` — packages + github metadata for latest versions, excluding missing/redirected
- `getModules(db, versionId)` — modules for a version
- `getValues(db, moduleId)` — functions/constants with types
- `getUnions(db, moduleId)` — custom types
- `getAliases(db, moduleId)` — type aliases
- `getBinops(db, moduleId)` — binary operators

### Step 3: `lib/ranking.ts` — Package scoring

```
score = log(1 + stars)/log(1 + maxStars) * 0.4
      + recencyScore(lastCommitAt) * 0.3
      + healthScore(issues, prs) * 0.2
      + orgBoost(org) * 0.1
```

- `elm/*` → org boost 1.0, `elm-community/*` and `elm-explorations/*` → 0.7
- Recency: 1.0 for <1 year, decaying to 0 at 5+ years
- Excludes packages with `missing IS NOT NULL` or `redirect_to IS NOT NULL`
- Returns sorted list; top ~200 appear in llms.txt/llms-full.txt

### Step 4: `lib/categories.ts` — Categorization logic

- Load `categories.json`
- For uncategorized packages: keyword match against name, summary, and first few module names
- Return `Map<categoryId, Package[]>` structure

### Step 4b: `lib/tags.ts` — Populate package_tags table

- After categorization, write all category assignments into the `package_tags` table
- Clear existing tags first (full rebuild), then INSERT each (package_id, tag) pair
- Uses the category id as the tag value (e.g., "core", "ui", "parsing")
- Runs inside a transaction

### Step 5: `lib/render.ts` — Markdown rendering

Three pure functions:
- `renderLlmsTxt(categories, packages)` → string
- `renderLlmsFullTxt(categories, packages, moduleData)` → string
- `renderPackageMd(pkg, modules, values, unions, aliases, binops)` → string

Handles: stripping `@docs` directives from Elm comments, graceful handling of empty comments, limiting key functions in llms-full.txt to ~10 per module.

### Step 6: `generate.ts` — CLI entry point

Follow the pattern from `buildDb.ts` and `search.ts`:
- Flags: `--db <path>`, `--out <dir>`, `--top <n>` (how many packages in llms.txt), `--help`
- Opens DB read-only
- Runs queries → ranking → categorization → rendering → writes files
- Progress output to terminal

### Step 7: Wire up npm script

Add to `package.json`:
```json
"generate-llms-txt": "tsx llms-txt/generate.ts"
```

Run via: `nix develop --command npm run generate-llms-txt`

## Key Files to Reference

| Existing File | Why |
|---|---|
| `db/buildDb.ts` | CLI pattern, arg parsing, progress output |
| `db/lib/db.ts` | `openDb()`, full schema for writing queries |
| `db/lib/ingest.ts` | "Latest version" subquery, prepared statement patterns |
| `type-search/search.ts` | Read-only DB access pattern |
| `package-elm-lang-org/lib/term.ts` | Terminal output helpers (`dim`, `green`, `writeLine`) |

## Verification

1. Run `nix develop --command npm run generate-llms-txt` — should produce files in `llms-txt/out/`
2. Check `llms.txt` has proper H1, blockquote, H2 categories, and markdown links
3. Check `llms-full.txt` has inline content for top packages
4. Spot-check a few per-package `.md` files (e.g., `elm/core.md`, `elm/json.md`) for complete module/function listings
5. Verify the "Optional" section contains lower-ranked packages
6. Feed `llms.txt` to an LLM and ask "what Elm package should I use for JSON parsing?" — it should point to `elm/json`
