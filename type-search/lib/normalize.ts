import type { Type } from "./types.ts";

const RESERVED_VARS = new Set([
  "number",
  "comparable",
  "appendable",
  "compappend",
]);

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function nextCanonicalName(index: number): string {
  if (index < 26) return LETTERS[index];
  // a1, b1, c1, ... for overflow (unlikely but safe)
  return LETTERS[index % 26] + Math.floor(index / 26);
}

/**
 * Normalize type variables to canonical names (a, b, c, ...).
 * Reserved vars (number, comparable, appendable, compappend) keep their names.
 */
export function normalize(type: Type): Type {
  // Collect var names in order of first appearance
  const seen: string[] = [];
  collectVars(type, seen);

  // Build mapping: original name → canonical name
  const mapping = new Map<string, string>();
  let nextIdx = 0;
  for (const name of seen) {
    if (mapping.has(name)) continue;
    if (RESERVED_VARS.has(name)) {
      mapping.set(name, name);
    } else {
      // Skip canonical names that collide with reserved vars
      let canonical: string;
      do {
        canonical = nextCanonicalName(nextIdx++);
      } while (RESERVED_VARS.has(canonical));
      mapping.set(name, canonical);
    }
  }

  return renameVars(type, mapping);
}

function collectVars(type: Type, seen: string[]): void {
  switch (type.tag) {
    case "var":
      if (!seen.includes(type.name)) seen.push(type.name);
      break;
    case "fn":
      for (const arg of type.args) collectVars(arg, seen);
      collectVars(type.result, seen);
      break;
    case "app":
      for (const arg of type.args) collectVars(arg, seen);
      break;
    case "tuple":
      for (const arg of type.args) collectVars(arg, seen);
      break;
    case "record":
      if (type.ext && !seen.includes(type.ext)) seen.push(type.ext);
      for (const [, ft] of type.fields) collectVars(ft, seen);
      break;
  }
}

function renameVars(type: Type, mapping: Map<string, string>): Type {
  switch (type.tag) {
    case "var":
      return { tag: "var", name: mapping.get(type.name) ?? type.name };
    case "fn":
      return {
        tag: "fn",
        args: type.args.map((a) => renameVars(a, mapping)),
        result: renameVars(type.result, mapping),
      };
    case "app":
      return {
        tag: "app",
        name: type.name,
        args: type.args.map((a) => renameVars(a, mapping)),
      };
    case "tuple":
      return {
        tag: "tuple",
        args: type.args.map((a) => renameVars(a, mapping)),
      };
    case "record":
      return {
        tag: "record",
        fields: type.fields.map(([n, t]) => [n, renameVars(t, mapping)]),
        ext: type.ext ? (mapping.get(type.ext) ?? type.ext) : null,
      };
  }
}
