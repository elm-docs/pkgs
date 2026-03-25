import type Database from "better-sqlite3";
import type { Type } from "./types.ts";
import { parseType } from "./parse.ts";
import { normalize } from "./normalize.ts";
import { fingerprint, fingerprintCompatible, countArgs } from "./fingerprint.ts";
import { distance, packageBoost } from "./distance.ts";

export interface SearchResult {
  package: string;
  module: string;
  name: string;
  kind: string;
  typeRaw: string;
  distance: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0.125;

export function searchByType(
  db: Database.Database,
  query: string,
  opts?: SearchOptions,
): SearchResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

  // 1. Parse and normalize query
  let queryAst: Type;
  try {
    queryAst = normalize(parseType(query, { lenient: true }));
  } catch (e: any) {
    throw new Error(`Failed to parse type query: ${e.message}`);
  }

  const queryFp = fingerprint(queryAst);
  const queryArgCount = countArgs(queryAst);

  // 2. Fetch candidates from DB (pre-filter by arg count ±1)
  const minArgs = Math.max(0, queryArgCount - 1);
  const maxArgs = queryArgCount + 1;

  const rows = db.prepare(`
    SELECT ti.module_name, ti.name, ti.kind, ti.type_raw, ti.type_ast, ti.fingerprint,
           p.org, p.name AS pkg_name
    FROM type_index ti
    JOIN packages p ON ti.package_id = p.id
    WHERE ti.arg_count BETWEEN ? AND ?
  `).all(minArgs, maxArgs) as {
    module_name: string;
    name: string;
    kind: string;
    type_raw: string;
    type_ast: string;
    fingerprint: string;
    org: string;
    pkg_name: string;
  }[];

  // 3. Filter and score
  const results: SearchResult[] = [];

  for (const row of rows) {
    // Fingerprint pre-filter
    if (!fingerprintCompatible(queryFp, row.fingerprint)) continue;

    // Deserialize candidate AST and compute distance
    let candidateAst: Type;
    try {
      candidateAst = JSON.parse(row.type_ast);
    } catch {
      continue;
    }

    let dist = distance(queryAst, candidateAst);

    // Apply package boost
    dist += packageBoost(row.org, row.pkg_name);

    if (dist <= threshold) {
      results.push({
        package: `${row.org}/${row.pkg_name}`,
        module: row.module_name,
        name: row.name,
        kind: row.kind,
        typeRaw: row.type_raw,
        distance: dist,
      });
    }
  }

  // 4. Sort and limit
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, limit);
}
