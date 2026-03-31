# Type Search

Search Elm packages by type signature. Inspired by [elm-search](https://github.com/klaftertief/elm-search).

## Usage

```sh
nix develop --command npm run type-search -- "(a -> b) -> List a -> List b"
nix develop --command npm run type-search -- "String -> Int"
nix develop --command npm run type-search -- "a -> Maybe a"
```

Options:

```
--db <path>     Path to database (default: ~/.elm-docs/elm-packages.db)
--limit <n>     Max results (default: 20)
--threshold <f> Distance threshold (default: 0.125)
--json          Output as JSON
--help, -h      Show help
```

## How it works

### Build phase

During `npm run build-db`, the type index is built:

1. For each package, find the **latest version** (using semver-sortable `version_sort` column)
2. Parse every value, alias, and binop type string into an AST
3. Normalize type variables to canonical names (`a`, `b`, `c`, ...)
4. Generate a structural fingerprint for pre-filtering
5. Store the AST, fingerprint, and metadata in the `type_index` table (~217K rows)

The build is incremental — only packages with new versions are re-indexed.

### Query phase

1. Parse the user's query in **lenient mode** (unqualified names like `List` auto-resolve to `List.List`)
2. Normalize type variables
3. Generate fingerprint
4. Pre-filter candidates by arg count (±1) and fingerprint overlap (eliminates ~80-90%)
5. Compute distance between query and each remaining candidate using a penalty-based algorithm
6. Apply package priority boosts (elm/core > elm/* > elm-community/*)
7. Return results sorted by distance

### Distance algorithm

Ported from elm-search's penalty-based metric:

| Penalty | Value | Meaning |
|---------|-------|---------|
| None    | 0.0   | Exact match |
| Low     | 0.25  | Reserved var matches concrete type |
| Medium  | 0.5   | Generic var matches concrete type |
| Max     | 1.0   | No match |

Key behaviors:
- **Function matching**: tries all permutations of arguments (capped at 6) to find best alignment
- **Reserved variables**: `number` matches `Float`/`Int`, `comparable` matches `Float`/`Int`/`Char`/`String`, `appendable` matches `String`/`List`
- **Package boosts**: elm/core gets -0.125, elm/* gets -0.083, elm-community/* gets -0.0625

### Normalization

Type variables are renamed to canonical sequential names:

```
(x -> y -> x)       →  (a -> b -> a)
(foo -> bar -> foo)  →  (a -> b -> a)
```

Reserved variables (`number`, `comparable`, `appendable`) keep their names.

### Fingerprint

Compact structural string for cheap pre-filtering:

```
"(a -> Bool) -> List a -> List a"  →  "F2:Bool,List,List"
"Int -> String"                     →  "F1:Int,String"
"a -> b -> a"                       →  "F2:"
```

Format: `F{argCount}:{sorted concrete type names}`.
