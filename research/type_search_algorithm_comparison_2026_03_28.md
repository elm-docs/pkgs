# Three-Way Comparison: Our Elm Implementation vs elm-search vs Hoogle

## 1. Architecture Overview

| | **Our implementation** | **elm-search** | **Hoogle** |
|---|---|---|---|
| Language | Elm (elm-pages script) | Elm (client-side) | Haskell |
| Index | SQLite `type_index` table, pre-built | In-memory flat list, built at startup | Binary `.hoo` database |
| Pre-filtering | Fingerprint (`F{arity}:{concretes}`) + arg count +/-1 | None -- brute-force over all entries | Fingerprint + arity + rare constructor check |
| Matching | Penalty-based distance with variable bindings | Penalty-based distance, no bindings | Proper Robinson unification |
| Permutations | All permutations up to 6 args | All permutations (no cap) | Permutations up to ~4 args |
| Ecosystem scope | All published Elm packages (~1,500) | All published Elm packages | All of Hackage (~15,000+) |

## 2. The Core Matching Question: Bindings vs No Bindings vs Unification

This is the most important algorithmic difference across the three approaches.

**elm-search (no bindings):** Variables are compared by *name after normalization*. `Var "a"` matches `Var "a"` -> 0.0, and `Var "a"` matches `App Int` -> 0.5. But there is no tracking of *what* `a` was bound to. If a query `a -> a -> Bool` is compared against `Int -> String -> Bool`, the elm-search algorithm would score each position independently -- both `a`-vs-`Int` and `a`-vs-`String` get 0.5 -- producing a moderate score even though the two `a`s were unified with *different* types. This is a false positive.

**Our implementation (bindings, but imperfect):** We thread a `Dict String Type` through comparisons. When `a` first matches `Int`, we bind `a := Int`. When `a` appears again, we resolve the binding and compare `Int` against the candidate. This catches the inconsistency above -- the second `a` position would compare `Int` vs `String` = 1.0 (max penalty). However, our bindings are **per-permutation copies** using `Dict.union`, not carried through the full recursive descent consistently. In `bestPermutationDistance`, each permutation gets a fresh copy of the bindings, and the winning permutation's bindings are discarded -- they don't propagate to the result distance calculation. So binding enforcement is partial.

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
| Penalty for reordering | None | None (TODO in code) | Small cost |
| Partial application | One side wrapped as 0-arg fn | Limited (TODO) | Full sub-sequence matching |

All three try permutations. Our cap of 6 is generous -- real-world Elm functions rarely exceed 4-5 arguments, and 6! = 720 is still fast. None of the Elm approaches penalize reordering, which means `String -> Int -> Bool` scores identically to `Int -> String -> Bool` -- debatable whether this is desired. Hoogle adds a small cost, correctly treating argument order as a weak signal.

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

1. **Variable binding tracking** -- catches inconsistent variable assignments that elm-search misses
2. **Pre-filtering** -- fingerprint + SQL arity filter vs brute-force
3. **Record type matching** -- functional vs maxPenalty stub
4. **Module-qualified name matching** -- our `nameDistance` considers home module; elm-search's `distanceCanonical` ignores it
5. **Permutation cap** -- prevents combinatorial explosion for pathological inputs
6. **Configurable threshold and limit** -- elm-search hardcodes 0.125

## 8. What Hoogle Does Better Than Us

1. **Sound variable unification** -- no false positives from inconsistent bindings
2. **Type class constraint awareness** -- not applicable to Elm, but shows more principled handling of constrained types
3. **Type synonym expansion** -- Hoogle expands `String` -> `[Char]`; we don't expand Elm type aliases
4. **Partial application matching** -- Hoogle tries sub-sequences of argument lists; we only wrap as 0-arg fn
5. **Rarity-weighted pre-filtering** -- more effective fingerprinting
6. **Permutation penalty** -- treats argument reordering as a weak negative signal

## 9. Potential Improvements (informed by this analysis)

- **Full binding propagation**: Our bindings are partially discarded across permutations and between arg/result distance in `fnDistance`. Carrying them through fully would close the gap with Hoogle's consistency guarantee.
- **Permutation cost**: Add a small penalty (e.g., 0.05) when arguments need reordering, as Hoogle does.
- **Type alias expansion**: If we expanded aliases at index-build time, `Name` would match `String` and `Url` would match its definition.
- **Partial application**: Try matching the query against the last N arguments of a candidate, not just wrapping as zero-arg.
