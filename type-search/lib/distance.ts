import type { Type, QualifiedName } from "./types.ts";

// Penalty values (port of elm-search)
const NO_PENALTY = 0.0;
const LOW_PENALTY = 0.25;
const MEDIUM_PENALTY = 0.5;
const MAX_PENALTY = 1.0;

// Reserved variable → compatible concrete types
const RESERVED_MATCHES: Record<string, Set<string>> = {
  number: new Set(["Float", "Int"]),
  comparable: new Set(["Float", "Int", "Char", "String"]),
  appendable: new Set(["String", "List"]),
  compappend: new Set(["String"]),
};

const MAX_PERMUTATION_ARGS = 6;

/**
 * Compute the distance between a query type and a candidate type.
 * Lower is better. 0.0 = exact match, 1.0 = no match.
 */
export function distance(query: Type, candidate: Type): number {
  return typeDistance(query, candidate, new Map());
}

function typeDistance(
  q: Type,
  c: Type,
  bindings: Map<string, Type>,
): number {
  // fn vs fn
  if (q.tag === "fn" && c.tag === "fn") {
    return fnDistance(q.args, q.result, c.args, c.result, bindings);
  }

  // fn vs non-fn: wrap non-fn as zero-arg fn
  if (q.tag === "fn" && c.tag !== "fn") {
    return fnDistance(q.args, q.result, [], c, bindings);
  }
  if (q.tag !== "fn" && c.tag === "fn") {
    return fnDistance([], q, c.args, c.result, bindings);
  }

  // var vs anything
  if (q.tag === "var") return varDistance(q.name, c, bindings);
  if (c.tag === "var") return varDistance(c.name, q, bindings);

  // app vs app
  if (q.tag === "app" && c.tag === "app") {
    return appDistance(q, c, bindings);
  }

  // tuple vs tuple
  if (q.tag === "tuple" && c.tag === "tuple") {
    return listDistance(q.args, c.args, bindings);
  }

  // record vs record
  if (q.tag === "record" && c.tag === "record") {
    return recordDistance(q, c, bindings);
  }

  return MAX_PENALTY;
}

function fnDistance(
  qArgs: Type[],
  qResult: Type,
  cArgs: Type[],
  cResult: Type,
  bindings: Map<string, Type>,
): number {
  const resultDist = typeDistance(qResult, cResult, bindings);

  if (qArgs.length === 0 && cArgs.length === 0) {
    return resultDist;
  }

  // Try permutations of the shorter arg list against the longer
  const [shorter, longer] =
    qArgs.length <= cArgs.length ? [qArgs, cArgs] : [cArgs, qArgs];

  if (shorter.length === 0) {
    // One side has no args — penalize based on how many the other has
    const argPenalty = longer.length > 0 ? MEDIUM_PENALTY : NO_PENALTY;
    return (resultDist + argPenalty) / 2;
  }

  // If too many args, skip permutation testing
  if (shorter.length > MAX_PERMUTATION_ARGS) {
    const argDist = listDistance(qArgs, cArgs, bindings);
    return (argDist + resultDist) / 2;
  }

  // Try all permutations of shorter against longer (pad shorter if needed)
  const bestArgDist = bestPermutationDistance(shorter, longer, bindings);
  return (bestArgDist + resultDist) / 2;
}

function bestPermutationDistance(
  shorter: Type[],
  longer: Type[],
  bindings: Map<string, Type>,
): number {
  // Generate permutations of indices into `longer`, choose `shorter.length` of them
  const indices = Array.from({ length: longer.length }, (_, i) => i);
  let best = MAX_PENALTY;

  for (const perm of permutations(indices, shorter.length)) {
    let sum = 0;
    for (let i = 0; i < shorter.length; i++) {
      sum += typeDistance(shorter[i], longer[perm[i]], new Map(bindings));
    }
    // Penalize unmatched args in longer
    const unmatchedPenalty =
      ((longer.length - shorter.length) * MEDIUM_PENALTY) / longer.length;
    const avg = sum / shorter.length;
    const dist = avg * (shorter.length / longer.length) + unmatchedPenalty;
    if (dist < best) best = dist;
    if (best === NO_PENALTY) break;
  }

  return best;
}

function* permutations(
  arr: number[],
  k: number,
): Generator<number[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest, k - 1)) {
      yield [arr[i], ...perm];
    }
  }
}

/**
 * Resolve a variable through the binding chain, following var→var links.
 * Returns the final non-var type, or the last var if the chain is all vars.
 */
function resolveVar(name: string, bindings: Map<string, Type>): Type | null {
  const seen = new Set<string>();
  let current = name;
  while (true) {
    if (seen.has(current)) return { tag: "var", name: current }; // cycle
    seen.add(current);
    const bound = bindings.get(current);
    if (!bound) return null;
    if (bound.tag === "var") {
      current = bound.name;
      continue;
    }
    return bound;
  }
}

function varDistance(
  varName: string,
  other: Type,
  bindings: Map<string, Type>,
): number {
  // Resolve through binding chain
  const resolved = resolveVar(varName, bindings);
  if (resolved) {
    if (resolved.tag === "var") {
      // Bound to a var (possibly through a chain)
      if (other.tag === "var") return NO_PENALTY;
      // Var bound to var, but other is concrete — treat as fresh binding
    } else {
      // Bound to a concrete type — compare it with other
      if (other.tag === "var") {
        // other is a var — bind it and compare
        bindings.set(other.name, resolved);
        return NO_PENALTY;
      }
      return typeDistance(resolved, other, bindings);
    }
  }

  // Bind the variable
  bindings.set(varName, other);

  // Reserved vars matching concrete types
  if (RESERVED_MATCHES[varName]) {
    if (other.tag === "app" && other.args.length === 0) {
      if (RESERVED_MATCHES[varName].has(other.name.name)) {
        return LOW_PENALTY;
      }
    }
    // Generic match
    return MEDIUM_PENALTY;
  }

  // Generic variable matches anything
  if (other.tag === "var") return NO_PENALTY;
  return MEDIUM_PENALTY;
}

function appDistance(
  q: Type & { tag: "app" },
  c: Type & { tag: "app" },
  bindings: Map<string, Type>,
): number {
  const nameDist = nameDistance(q.name, c.name);
  if (nameDist >= MAX_PENALTY) return MAX_PENALTY;

  if (q.args.length === 0 && c.args.length === 0) {
    return nameDist;
  }

  const argsDist = listDistance(q.args, c.args, bindings);
  // Weight: name match matters more
  return nameDist * 0.4 + argsDist * 0.6;
}

function nameDistance(q: QualifiedName, c: QualifiedName): number {
  // Exact match (including home)
  if (q.home === c.home && q.name === c.name) return NO_PENALTY;

  // Same name, different/missing home (e.g. unqualified query)
  if (q.name === c.name) {
    if (q.home === "" || c.home === "") return NO_PENALTY;
    return LOW_PENALTY;
  }

  // Substring match
  const qLower = q.name.toLowerCase();
  const cLower = c.name.toLowerCase();
  if (qLower.includes(cLower) || cLower.includes(qLower)) {
    return MEDIUM_PENALTY;
  }

  return MAX_PENALTY;
}

function listDistance(
  qs: Type[],
  cs: Type[],
  bindings: Map<string, Type>,
): number {
  if (qs.length === 0 && cs.length === 0) return NO_PENALTY;

  const maxLen = Math.max(qs.length, cs.length);
  let sum = 0;
  for (let i = 0; i < maxLen; i++) {
    if (i < qs.length && i < cs.length) {
      sum += typeDistance(qs[i], cs[i], bindings);
    } else {
      sum += MAX_PENALTY;
    }
  }
  return sum / maxLen;
}

function recordDistance(
  q: Type & { tag: "record" },
  c: Type & { tag: "record" },
  bindings: Map<string, Type>,
): number {
  if (q.fields.length === 0 && c.fields.length === 0) return NO_PENALTY;

  // Match fields by name
  const cMap = new Map(c.fields);
  let matched = 0;
  let sum = 0;

  for (const [name, qType] of q.fields) {
    const cType = cMap.get(name);
    if (cType) {
      sum += typeDistance(qType, cType, bindings);
      matched++;
    } else {
      sum += MAX_PENALTY;
    }
  }

  const total = Math.max(q.fields.length, c.fields.length);
  const unmatched = total - matched;
  sum += unmatched * MAX_PENALTY;

  return sum / total;
}

// Package priority boosts
export function packageBoost(org: string, name: string): number {
  const pkg = `${org}/${name}`;
  if (pkg === "elm/core") return -0.125;
  if (org === "elm") return -0.083;
  if (org === "elm-community" || org === "elm-explorations") return -0.0625;
  return 0;
}
