# Analysis: Bundling elm-docs with Deno or Bun

## Context

The CLI is currently Node.js 22 + elm-pages (compiles/runs Elm scripts) + better-sqlite3 (native C++ addon). The Nix shell provides a reproducible environment. The question: could Deno or Bun simplify distribution or reduce complexity?

## The Blocking Constraint: elm-pages

elm-pages is the core orchestrator. When `elm-pages run src/Foo.elm` executes, it:
1. Generates wrapper Elm code and rewrites `elm.json`
2. Shells out to `lamdera make` (Elm compiler fork) via `cross-spawn`
3. Calls `esbuild.build()` to bundle `custom-backend-task.ts`
4. Uses Node.js `import()` to load compiled code
5. Runs the Elm program via a renderer using `global`, `process`, `crypto`, `zlib`, `readline`

elm-pages has deep Node.js assumptions and has never been tested on Deno or Bun. Its dependency tree (`esbuild`, `cross-spawn`, `memfs`, `make-fetch-happen`, `globby`) creates a long tail of potential incompatibilities. **Neither runtime can be a drop-in replacement for `elm-pages run`.**

## Deno

| Aspect | Assessment |
|--------|------------|
| elm-pages compat | Very unlikely to work -- Deno's Node compat layer gaps + elm-pages' deep Node assumptions |
| SQLite | `@db/sqlite` (FFI-based, no native addon). Significantly different API from better-sqlite3 -- no `db.pragma()`, different query patterns, manual transactions. ~30-40 call sites to rewrite |
| Node API coverage | Missing `fs.globSync` (Node 22 feature). Needs extensive `--allow-*` flags, negating the permissions model |
| `deno compile` | Cannot bundle native addons, `lamdera` binary, or `esbuild` binary. The resulting binary would still need external tools at runtime |
| Migration effort | High. SQLite rewrite + globSync polyfill + permissions + elm-pages is a likely dead end |

## Bun

| Aspect | Assessment |
|--------|------------|
| elm-pages compat | Better odds than Deno (aims for Node drop-in), but untested. `cross-spawn`, esbuild binary resolution, `global.XMLHttpRequest` hack are risk areas |
| SQLite | `bun:sqlite` built-in, API intentionally similar to better-sqlite3. Main change: `db.pragma("X")` -> `db.exec("PRAGMA X")`. Most other calls work as-is |
| Node API coverage | Good. `globSync` support needs verification but likely works in recent Bun |
| `bun build --compile` | Same limitation -- cannot bundle external binaries (`lamdera`, `esbuild`) needed at runtime |
| Migration effort | Low-medium for SQLite swap. Unknown for elm-pages compat |

## Three Possible Approaches

### A. Drop-in runtime swap (Bun or Deno replaces Node)
- **Effort**: Low-medium (SQLite swap) but **risk is high** -- elm-pages compatibility is a coin flip
- **Gain**: Eliminates Python 3 dependency (no native addon compilation), faster `bun install`
- **Verdict**: Not recommended. High risk for marginal gain.

### B. Pre-bundle with `elm-pages bundle-script`, then compile
- Use `elm-pages bundle-script` (on Node) during build to produce self-contained `.mjs` files
- Rewrite `bin/elm-docs.mjs` to import bundled scripts directly instead of shelling out to `elm-pages run`
- Swap SQLite library, then use `deno compile` or `bun build --compile`
- **Effort**: High (1-2 week project). Build pipeline change, architecture change, SQLite swap
- **Gain**: Single-binary distribution without Nix/npm. Real improvement for end users
- **Verdict**: Only worth it if single-binary distribution is an actual goal

### C. Stay on Node, swap only the SQLite library
- Replace better-sqlite3 with a WASM-based SQLite (e.g., `sql.js`) or use better-sqlite3's prebuilt binaries
- **Effort**: Medium (SQLite API migration in `custom-backend-task.ts`)
- **Gain**: Eliminates Python 3 build dependency. No elm-pages risk
- **Verdict**: Best risk/reward if the Python 3 dependency is the pain point

## Recommendation

**Bun is the better fit** if you pursue this -- its SQLite is nearly API-compatible with better-sqlite3 and its Node compatibility is stronger than Deno's. But neither runtime solves the elm-pages problem.

The practical path forward depends on the actual goal:
- **"I want easier distribution"** -> Approach B (pre-bundle + compile). Significant work but achievable. Bun is the better target runtime.
- **"I want fewer build dependencies"** -> Approach C (swap SQLite, stay on Node). Lower risk, addresses the main pain point (Python 3 for native compilation).
- **"I'm just curious"** -> The complexity cost is substantial for either runtime, primarily because of elm-pages. Not worth pursuing without a clear distribution or DX goal driving it.
