# Three-Way Comparison: Our Elm Implementation vs elm-search vs Hoogle (v2)

> **Changelog from v1:** Updated to reflect binding threading through permutations, permutation reorder penalty (0.05), and trailing subsequence partial application matching (0.12/skipped arg, up to 3). Three of the four "Potential Improvements" from v1 are now implemented.

## 1. Architecture Overview

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| Language | Elm (elm-pages script) | Elm (client-side) | Haskell |
| Index | SQLite `type_index` table, pre-built | In-memory flat list, built at startup | Binary `.hoo` database |
| Pre-filtering | Fingerprint (`F{arity}:{concretes}`) + arg count +/-1 | None -- brute-force over all entries | Fingerprint + arity + rare constructor check |
| Matching | Penalty-based distance with threaded variable bindings | Penalty-based distance, no bindings | Proper Robinson unification |
| Permutations | All permutations up to 6 args, with reorder penalty | All permutations (no cap), no penalty | Permutations up to ~4 args, with small cost |
| Partial application | Trailing subsequence (up to 3 skipped args) | Limited (TODO in code) | Full sub-sequence matching |
| Ecosystem scope | All published Elm packages (~1,500) | All published Elm packages | All of Hackage (~15,000+) |

## 2. The Core Matching Question: Bindings vs No Bindings vs Unification

This is the most important algorithmic difference across the three approaches.

**elm-search (no bindings):** Variables are compared by *name after normalization*. `Var "a"` matches `Var "a"` -> 0.0, and `Var "a"` matches `App Int` -> 0.5. But there is no tracking of *what* `a` was bound to. If a query `a -> a -> Bool` is compared against `Int -> String -> Bool`, the elm-search algorithm would score each position independently -- both `a`-vs-`Int` and `a`-vs-`String` get 0.5 -- producing a moderate score even though the two `a`s were unified with *different* types. This is a false positive.

**Our implementation (threaded bindings):** We thread a `Dict String Type` through all comparisons, including across permutation scoring. When `a` first matches `Int`, we bind `a := Int`. When `a` appears again, we resolve the binding and compare `Int` against the candidate. This catches the inconsistency above -- the second `a` position would compare `Int` vs `String` = 1.0 (max penalty).

Bindings propagate fully:
- Through `listDistance` (each element comparison carries forward the bindings from the previous)
- Through `scorePermutation` (uses `List.foldl` to thread bindings across all matched pairs)
- Back from `bestPermutationDistance` to `fnDistance` (the winning permutation's bindings are returned and used for the result distance)
- Through the partial application path (trailing subsequence matching threads bindings through arg and result comparisons)

The remaining gap with Hoogle is that our bindings are *additive* -- once `a := Int`, that binding is never reconsidered. Hoogle's Robinson unification can backtrack and try alternative assignments. In practice, this rarely matters because Elm types have fewer polymorphic constraints than Haskell.

**Hoogle (full unification):** Robinson unification with occurs check. A variable maps to exactly one type globally, enforced by the unification algorithm. If unification fails, the candidate is rejected entirely (binary outcome), and the *cost* of the match comes from transformations needed (permutations, generalizations), not from type distance. This is sound -- no false positives from inconsistent variable assignment.

## 3. Scoring: Continuous vs Binary

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| Match outcome | Continuous [0, 1] distance | Continuous [0, 1] distance | Binary (unifies or not) + transformation cost |
| Threshold | Configurable (default 0.125) | Fixed at 0.125 | Implicit (transformation budget) |

The penalty approach produces *graded* results -- you see how "close" a near-miss is. Hoogle's approach is more precise but less forgiving: if unification fails, the candidate is gone, period. Hoogle compensates by trying many transformations (permutations, partial application, etc.) before giving up.

For a small ecosystem like Elm's, the penalty approach is arguably more useful -- you'd rather see a "close but not exact" match than get zero results.

## 4. Pre-filtering Efficiency

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| DB pre-filter | SQL `WHERE arg_count BETWEEN ? AND ?` | None | Arity + fingerprint |
| Fingerprint filter | `fingerprintCompatible` (arity +/-1, concrete overlap) | None | Constructor rarity weighting |
| Estimated elimination | ~80-90% of candidates | 0% | ~95%+ |

Our approach is a significant improvement over elm-search's brute-force. The SQL arg-count filter eliminates most rows before they even reach Elm, and the fingerprint compatibility check (which we ported from the TS version, not from elm-search) catches most of the rest.

Hoogle goes further with *rarity-weighted* constructor checks -- a match on a rare constructor like `STRef` is much more discriminating than a match on `Int`. We could adopt this but it's probably unnecessary for Elm's smaller ecosystem.

## 5. Argument Permutation

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| Cap | 6 args (720 permutations max) | Uncapped | ~4 args |
| Penalty for reordering | 0.05 when perm differs from identity | None (TODO in code) | Small cost |
| Partial application | Trailing subsequence (up to 3 skipped args, 0.12/arg) | Limited (TODO) | Full sub-sequence matching |

All three try permutations. Our cap of 6 is generous -- real-world Elm functions rarely exceed 4-5 arguments, and 6! = 720 is still fast.

**Reorder penalty:** We now add `permutationPenalty = 0.05` when arguments need reordering, treating argument order as a weak signal -- matching Hoogle's approach. This means `String -> Int -> Bool` scores slightly worse than `Int -> String -> Bool` when the query is `Int -> String -> Bool`, correctly reflecting that the exact order is a better match.

**Partial application:** When the candidate has more arguments than the query (e.g., query `String -> Bool` vs candidate `String -> String -> Bool`), we try `trailingSubsequenceDistance`: match the query args against the *trailing* args of the candidate, adding `partialApplicationPenalty = 0.12` per skipped leading argument (up to `maxSkippableArgs = 3`). The best score across linear, permutation, and partial paths is chosen. This enables finding functions like `String.startsWith : String -> String -> Bool` when searching for `String -> Bool`.

## 6. Elm-Specific Features

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| Reserved vars (`number`, `comparable`, `appendable`) | Tracked with specific concrete matches (low penalty 0.25) | Same approach, same penalty values | N/A (Haskell uses type classes instead) |
| Lenient query parsing | Auto-resolves `Int` -> `Basics.Int`, `Maybe` -> `Maybe.Maybe`, etc. | Similar | N/A |
| Package boost | elm/core: -0.125, elm/*: -0.083, elm-community: -0.0625 | elm/core: -0.125, elm/*: -0.083, elm-community: -0.0625 | Package popularity weighting |
| Record types | Full distance comparison by field name matching | Defined in AST but returns maxPenalty (not implemented) | N/A (Haskell records are different) |
| Name substring matching | `distanceName` checks case-insensitive substring -> 0.5 | `distanceCanonical` checks substring -> 0.5 | N/A (name search is separate) |

Our record support is a genuine improvement over elm-search. We also added the `compappend` reserved variable which elm-search doesn't have.

## 7. What We Do Better Than elm-search

1. **Variable binding tracking** -- catches inconsistent variable assignments that elm-search misses; bindings thread through permutations and propagate back to callers
2. **Pre-filtering** -- fingerprint + SQL arity filter vs brute-force
3. **Record type matching** -- functional vs maxPenalty stub
4. **Module-qualified name matching** -- our `nameDistance` considers home module; elm-search's `distanceCanonical` ignores it
5. **Permutation cap** -- prevents combinatorial explosion for pathological inputs
6. **Permutation penalty** -- 0.05 cost for reordering, treating argument order as a weak signal; elm-search has no penalty
7. **Partial application matching** -- trailing subsequence matching finds functions with extra leading args; elm-search has only a TODO stub
8. **Configurable threshold and limit** -- elm-search hardcodes 0.125

## 8. What Hoogle Does Better Than Us

1. **Sound variable unification** -- Robinson unification with backtracking; our bindings are additive (no reconsidering once bound)
2. **Type class constraint awareness** -- not applicable to Elm, but shows more principled handling of constrained types
3. **Type synonym expansion** -- Hoogle expands `String` -> `[Char]`; we don't expand Elm type aliases
4. **Rarity-weighted pre-filtering** -- more effective fingerprinting based on constructor frequency

## 9. Potential Improvements (informed by this analysis)

- **Type alias expansion**: If we expanded aliases at index-build time, `Name` would match `String` and `Url` would match its definition. This is the main remaining gap with Hoogle that is applicable to Elm.
