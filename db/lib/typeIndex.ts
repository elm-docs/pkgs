import type Database from "better-sqlite3";
import { parseType } from "../../type-search/lib/parse.ts";
import { normalize } from "../../type-search/lib/normalize.ts";
import { fingerprint, countArgs } from "../../type-search/lib/fingerprint.ts";
import { writeLine } from "../../package-elm-lang-org/lib/term.ts";

interface LatestVersion {
  package_id: number;
  version_id: number;
}

/**
 * Build the type_index table from values, aliases, and binops.
 * Only indexes the latest version of each package.
 */
export function buildTypeIndex(db: Database.Database, full: boolean): number {
  if (full) {
    db.exec("DELETE FROM type_index");
  }

  // Find packages that need (re)indexing
  const packagesToIndex = findPackagesToIndex(db, full);

  if (packagesToIndex.length === 0) {
    return (db.prepare("SELECT count(*) as n FROM type_index").get() as { n: number }).n;
  }

  // Delete old entries for these packages
  const deleteStmt = db.prepare("DELETE FROM type_index WHERE package_id = ?");
  const deleteTx = db.transaction(() => {
    for (const p of packagesToIndex) {
      deleteStmt.run(p.package_id);
    }
  });
  deleteTx();

  // Build index for each package
  const insertStmt = db.prepare(`
    INSERT INTO type_index (package_id, version_id, module_name, name, kind, type_raw, type_ast, fingerprint, arg_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Fetch typed entries for the latest versions
  const fetchValues = db.prepare(`
    SELECT m.name AS module_name, v.name, v.type AS type_raw
    FROM "values" v
    JOIN modules m ON v.module_id = m.id
    WHERE m.version_id = ?
  `);

  const fetchAliases = db.prepare(`
    SELECT m.name AS module_name, a.name, a.type AS type_raw
    FROM aliases a
    JOIN modules m ON a.module_id = m.id
    WHERE m.version_id = ?
  `);

  const fetchBinops = db.prepare(`
    SELECT m.name AS module_name, b.name, b.type AS type_raw
    FROM binops b
    JOIN modules m ON b.module_id = m.id
    WHERE m.version_id = ?
  `);

  let totalInserted = 0;
  let parseErrors = 0;

  const insertTx = db.transaction(() => {
    for (let i = 0; i < packagesToIndex.length; i++) {
      const pkg = packagesToIndex[i];
      if (i % 100 === 0) {
        writeLine(`  Indexing types ${i + 1}/${packagesToIndex.length}...`);
      }

      const entries: { module_name: string; name: string; type_raw: string; kind: string }[] = [];

      for (const row of fetchValues.all(pkg.version_id) as any[]) {
        entries.push({ ...row, kind: "value" });
      }
      for (const row of fetchAliases.all(pkg.version_id) as any[]) {
        entries.push({ ...row, kind: "alias" });
      }
      for (const row of fetchBinops.all(pkg.version_id) as any[]) {
        entries.push({ ...row, kind: "binop" });
      }

      for (const entry of entries) {
        try {
          const ast = normalize(parseType(entry.type_raw));
          const fp = fingerprint(ast);
          const argCount = countArgs(ast);
          const astJson = JSON.stringify(ast);

          insertStmt.run(
            pkg.package_id,
            pkg.version_id,
            entry.module_name,
            entry.name,
            entry.kind,
            entry.type_raw,
            astJson,
            fp,
            argCount,
          );
          totalInserted++;
        } catch {
          parseErrors++;
        }
      }
    }
  });
  insertTx();

  if (parseErrors > 0) {
    writeLine("");
    console.log(`  (${parseErrors} types skipped due to parse errors)`);
  }

  return (db.prepare("SELECT count(*) as n FROM type_index").get() as { n: number }).n;
}

function findPackagesToIndex(db: Database.Database, full: boolean): LatestVersion[] {
  if (full) {
    // Index all packages — pick the latest version for each
    return db.prepare(`
      SELECT p.id AS package_id, pv.id AS version_id
      FROM packages p
      JOIN package_versions pv ON pv.package_id = p.id
      WHERE pv.version_sort = (
        SELECT MAX(pv2.version_sort)
        FROM package_versions pv2
        WHERE pv2.package_id = p.id
      )
    `).all() as LatestVersion[];
  }

  // Incremental: find packages whose latest version differs from what's indexed
  return db.prepare(`
    SELECT p.id AS package_id, pv.id AS version_id
    FROM packages p
    JOIN package_versions pv ON pv.package_id = p.id
    WHERE pv.version_sort = (
      SELECT MAX(pv2.version_sort)
      FROM package_versions pv2
      WHERE pv2.package_id = p.id
    )
    AND pv.id NOT IN (
      SELECT DISTINCT ti.version_id
      FROM type_index ti
      WHERE ti.package_id = p.id
    )
  `).all() as LatestVersion[];
}
