/**
 * Read-only database queries for the Elm package documentation database.
 * Shared between MCP server and (future) llms.txt generator.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Open a read-only connection to the SQLite database.
 */
export function openDb(dbPath) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Search packages by keyword. Matches against org, name, and summary.
 * Returns results ordered by rank (descending).
 *
 * When `projectDb` is provided, also queries the project context database
 * (without redirect/missing filters or allowedPackages) and merges results
 * with local project modules appearing first.
 */
export function searchPackages(db, { query, limit = 20, allowedPackages = null, projectDb = null }) {
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const likeClauses = terms.map(
    (_, i) =>
      `LOWER(p.org || ' ' || p.name || ' ' || COALESCE(p.summary, '')) LIKE @term${i}`,
  );
  const likeParams = {};
  terms.forEach((t, i) => {
    likeParams[`term${i}`] = `%${t.toLowerCase()}%`;
  });

  // --- Main DB query ---
  const params = { ...likeParams };

  let extraWhere = "";
  if (allowedPackages && allowedPackages.length > 0) {
    const placeholders = allowedPackages.map((_, i) => `@pkg${i}`).join(", ");
    extraWhere = `AND (p.org || '/' || p.name) IN (${placeholders})`;
    allowedPackages.forEach((pkg, i) => {
      params[`pkg${i}`] = pkg;
    });
  }

  params.limit = limit;

  const sql = `
    SELECT p.org || '/' || p.name AS package,
           COALESCE(p.summary, '') AS summary,
           p.rank,
           COALESCE(g.stargazers_count, 0) AS stars
    FROM packages p
    LEFT JOIN github g ON g.package_id = p.id
    WHERE p.redirect_to IS NULL AND p.missing IS NULL
      ${likeClauses.map((c) => `AND ${c}`).join("\n      ")}
      ${extraWhere}
    ORDER BY p.rank DESC
    LIMIT @limit
  `;

  const mainResults = db.prepare(sql).all(params);

  if (!projectDb) return mainResults;

  // --- Context DB query (no redirect/missing, no allowedPackages, no github) ---
  const localSql = `
    SELECT p.org || '/' || p.name AS package,
           COALESCE(p.summary, '') AS summary,
           p.rank,
           0 AS stars
    FROM packages p
    WHERE ${likeClauses.join("\n      AND ")}
    ORDER BY p.rank DESC
    LIMIT @limit
  `;

  const localResults = projectDb.prepare(localSql).all({ ...likeParams, limit });

  // Local results first, then main (deduplicated)
  const seen = new Set(localResults.map((r) => r.package));
  const merged = [...localResults, ...mainResults.filter((r) => !seen.has(r.package))];
  return merged.slice(0, limit);
}

/**
 * Get full documentation for a package (latest version).
 * Returns { package, version, modules } where each module has
 * { name, comment, values, unions, aliases, binops }.
 *
 * When `projectDb` is provided, checks the context DB first
 * (for local/app or the project's own package name), then falls through
 * to the global DB.
 */
export function getPackageDocs(db, { package: pkg, version = null, projectDb = null }) {
  if (projectDb) {
    const localResult = getPackageDocsFromDb(projectDb, pkg, version);
    if (localResult) return localResult;
  }
  return getPackageDocsFromDb(db, pkg, version);
}

/**
 * Get documentation for a specific module within a package.
 */
export function getModuleDocs(db, { package: pkg, module: moduleName, version = null, projectDb = null }) {
  const result = getPackageDocs(db, { package: pkg, version, projectDb });
  if (!result) return null;

  const mod = result.modules.find((m) => m.name === moduleName);
  if (!mod) return null;

  return {
    package: result.package,
    version: result.version,
    module: mod,
  };
}

/**
 * Look up a value/type/binop by name.
 * Accepts: "map", "List.map", "elm/core:List.map"
 *
 * When `projectDb` is provided, also searches the project context database
 * (without redirect/missing filters or allowedPackages) and merges results
 * with local project values appearing first.
 */
export function lookupValue(db, { name, allowedPackages = null, projectDb = null }) {
  // Parse the input: optional "pkg:" prefix, optional "Module." qualifier
  let pkgFilter = null;
  let moduleFilter = null;
  let valueName = name;

  // Check for package prefix: "elm/core:List.map"
  const colonIdx = name.indexOf(":");
  if (colonIdx !== -1) {
    pkgFilter = name.slice(0, colonIdx);
    valueName = name.slice(colonIdx + 1);
  }

  // Check for module qualifier: "List.map" → module="List", name="map"
  // But also handle "Json.Decode.field" → module="Json.Decode", name="field"
  const dotIdx = valueName.lastIndexOf(".");
  if (dotIdx !== -1) {
    const beforeDot = valueName.slice(0, dotIdx);
    const afterDot = valueName.slice(dotIdx + 1);
    // If afterDot starts with uppercase, it's all module name (e.g. "Json.Decode")
    // If afterDot starts with lowercase, it's a value name
    if (afterDot.length > 0 && afterDot[0] === afterDot[0].toLowerCase() && afterDot[0] !== afterDot[0].toUpperCase()) {
      moduleFilter = beforeDot;
      valueName = afterDot;
    }
  }

  const mainResults = lookupValueInDb(db, {
    valueName, moduleFilter, pkgFilter, allowedPackages, filterRedirects: true,
  });
  mainResults.sort((a, b) => b.rank - a.rank);

  if (!projectDb) return mainResults;

  const localResults = lookupValueInDb(projectDb, {
    valueName, moduleFilter, pkgFilter, filterRedirects: false,
  });
  localResults.sort((a, b) => b.rank - a.rank);

  // Local results first, then main (deduplicated by package+module+name+kind)
  const seen = new Set(
    localResults.map((r) => `${r.package}:${r.module}:${r.name}:${r.kind}`),
  );
  return [
    ...localResults,
    ...mainResults.filter((r) => !seen.has(`${r.package}:${r.module}:${r.name}:${r.kind}`)),
  ];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getPackageDocsFromDb(db, pkg, version) {
  const [org, name] = pkg.split("/");
  if (!org || !name) return null;

  const pkgRow = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?").get(org, name);
  if (!pkgRow) return null;

  let versionRow;
  if (version) {
    versionRow = db
      .prepare("SELECT id, version FROM package_versions WHERE package_id = ? AND version = ?")
      .get(pkgRow.id, version);
  } else {
    versionRow = db
      .prepare(
        "SELECT id, version FROM package_versions WHERE package_id = ? ORDER BY version_sort DESC LIMIT 1",
      )
      .get(pkgRow.id);
  }
  if (!versionRow) return null;

  const modules = fetchModules(db, versionRow.id);
  return { package: pkg, version: versionRow.version, modules };
}

function lookupValueInDb(db, { valueName, moduleFilter, pkgFilter, allowedPackages = null, filterRedirects = true }) {
  const results = [];

  for (const { table, kind, extraCols } of [
    { table: '"values"', kind: "value", extraCols: "v.type" },
    { table: "unions", kind: "union", extraCols: "v.args, v.cases" },
    { table: "aliases", kind: "alias", extraCols: "v.args, v.type" },
    { table: "binops", kind: "binop", extraCols: "v.type, v.associativity, v.precedence" },
  ]) {
    let where = "WHERE v.name = @name";
    const params = { name: valueName };

    if (filterRedirects) {
      where += " AND p.redirect_to IS NULL AND p.missing IS NULL";
    }

    if (moduleFilter) {
      where += " AND m.name = @module";
      params.module = moduleFilter;
    }

    if (pkgFilter) {
      where += " AND (p.org || '/' || p.name) = @pkg";
      params.pkg = pkgFilter;
    }

    if (allowedPackages && allowedPackages.length > 0) {
      const placeholders = allowedPackages.map((_, i) => `@apkg${i}`).join(", ");
      where += ` AND (p.org || '/' || p.name) IN (${placeholders})`;
      allowedPackages.forEach((pkg, i) => {
        params[`apkg${i}`] = pkg;
      });
    }

    const sql = `
      SELECT p.org || '/' || p.name AS package,
             pv.version,
             m.name AS module,
             v.name,
             v.comment,
             ${extraCols},
             p.rank
      FROM ${table} v
      JOIN modules m ON v.module_id = m.id
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${where}
        AND pv.version_sort = (
          SELECT MAX(pv2.version_sort)
          FROM package_versions pv2
          WHERE pv2.package_id = p.id
        )
      ORDER BY p.rank DESC
      LIMIT 20
    `;

    const rows = db.prepare(sql).all(params);
    for (const row of rows) {
      results.push({ ...row, kind });
    }
  }

  return results;
}

function fetchModules(db, versionId) {
  const modules = db
    .prepare("SELECT id, name, comment FROM modules WHERE version_id = ? ORDER BY name")
    .all(versionId);

  const fetchUnions = db.prepare(
    "SELECT name, comment, args, cases FROM unions WHERE module_id = ? ORDER BY name",
  );
  const fetchAliases = db.prepare(
    "SELECT name, comment, args, type FROM aliases WHERE module_id = ? ORDER BY name",
  );
  const fetchValues = db.prepare(
    'SELECT name, comment, type FROM "values" WHERE module_id = ? ORDER BY name',
  );
  const fetchBinops = db.prepare(
    "SELECT name, comment, type, associativity, precedence FROM binops WHERE module_id = ? ORDER BY name",
  );

  return modules.map((mod) => ({
    name: mod.name,
    comment: mod.comment,
    unions: fetchUnions.all(mod.id).map((u) => ({
      ...u,
      args: JSON.parse(u.args),
      cases: JSON.parse(u.cases),
    })),
    aliases: fetchAliases.all(mod.id).map((a) => ({
      ...a,
      args: JSON.parse(a.args),
    })),
    values: fetchValues.all(mod.id),
    binops: fetchBinops.all(mod.id),
  }));
}
