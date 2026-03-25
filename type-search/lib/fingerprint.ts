import type { Type } from "./types.ts";

/**
 * Generate a structural fingerprint for pre-filtering.
 * Format: F{argCount}:{sorted concrete type names}
 *
 * Example: "(a -> Bool) -> List a -> List a" → "F2:Bool,List,List"
 */
export function fingerprint(type: Type): string {
  const argCount = countArgs(type);
  const concretes: string[] = [];
  collectConcretes(type, concretes);
  concretes.sort();
  return `F${argCount}:${concretes.join(",")}`;
}

/**
 * Count top-level function arguments (0 for non-function types).
 */
export function countArgs(type: Type): number {
  if (type.tag === "fn") return type.args.length;
  return 0;
}

/**
 * Collect all concrete type names (non-variable type constructors).
 */
function collectConcretes(type: Type, out: string[]): void {
  switch (type.tag) {
    case "var":
      break;
    case "fn":
      for (const arg of type.args) collectConcretes(arg, out);
      collectConcretes(type.result, out);
      break;
    case "app":
      out.push(type.name.name);
      for (const arg of type.args) collectConcretes(arg, out);
      break;
    case "tuple":
      for (const arg of type.args) collectConcretes(arg, out);
      break;
    case "record":
      for (const [, ft] of type.fields) collectConcretes(ft, out);
      break;
  }
}

/**
 * Check if a candidate fingerprint could possibly match a query fingerprint.
 * Returns false if the candidate can be safely eliminated.
 */
export function fingerprintCompatible(
  queryFp: string,
  candidateFp: string,
): boolean {
  const qParts = parseFp(queryFp);
  const cParts = parseFp(candidateFp);

  // Arg count must be within 1
  if (Math.abs(qParts.argCount - cParts.argCount) > 1) return false;

  // If query has concrete types, at least one must appear in candidate
  if (qParts.concretes.length > 0 && cParts.concretes.length > 0) {
    const cSet = new Set(cParts.concretes);
    const hasOverlap = qParts.concretes.some((c) => cSet.has(c));
    if (!hasOverlap) return false;
  }

  return true;
}

function parseFp(fp: string): { argCount: number; concretes: string[] } {
  const colonIdx = fp.indexOf(":");
  const argCount = parseInt(fp.slice(1, colonIdx), 10);
  const rest = fp.slice(colonIdx + 1);
  const concretes = rest === "" ? [] : rest.split(",");
  return { argCount, concretes };
}
