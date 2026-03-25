import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import type Database from "better-sqlite3";
import { PACKAGES_DIR } from "../../package-elm-lang-org/lib/packages.ts";

// ---------------------------------------------------------------------------
// search.json → packages
// ---------------------------------------------------------------------------

interface SearchEntry {
  name: string;
  summary: string;
  license: string;
  version: string;
}

export function ingestSearchJson(db: Database.Database, path: string): number {
  const entries: SearchEntry[] = JSON.parse(readFileSync(path, "utf-8"));
  const upsert = db.prepare(`
    INSERT INTO packages (org, name, summary, license)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org, name) DO UPDATE SET summary = excluded.summary, license = excluded.license
  `);
  const tx = db.transaction(() => {
    for (const entry of entries) {
      const [org, name] = entry.name.split("/");
      upsert.run(org, name, entry.summary, entry.license);
    }
  });
  tx();
  return entries.length;
}

// ---------------------------------------------------------------------------
// docs.json → package_versions, modules, unions, aliases, values, binops
// ---------------------------------------------------------------------------

interface DocsModule {
  name: string;
  comment: string;
  unions: { name: string; comment: string; args: string[]; cases: [string, string[]][] }[];
  aliases: { name: string; comment: string; args: string[]; type: string }[];
  values: { name: string; comment: string; type: string }[];
  binops: { name: string; comment: string; type: string; associativity: string; precedence: number }[];
}

export function ingestDocsJson(
  db: Database.Database,
  docsPath: string,
): { packageId: number; versionId: number; moduleCount: number } | null {
  // Derive org/name/version from path: .../packages/<org>/<name>/<version>/docs.json
  const versionDir = dirname(docsPath);
  const rel = relative(PACKAGES_DIR, versionDir);
  const parts = rel.split("/");
  if (parts.length !== 3) return null;
  const [org, name, version] = parts;

  // Ensure package exists
  let row = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?").get(org, name) as { id: number } | undefined;
  if (!row) {
    db.prepare("INSERT INTO packages (org, name) VALUES (?, ?)").run(org, name);
    row = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?").get(org, name) as { id: number };
  }
  const packageId = row.id;

  // Insert version
  const versionSort = computeVersionSort(version);
  db.prepare(
    "INSERT OR IGNORE INTO package_versions (package_id, version, version_sort) VALUES (?, ?, ?)",
  ).run(packageId, version, versionSort);
  const versionRow = db.prepare(
    "SELECT id FROM package_versions WHERE package_id = ? AND version = ?",
  ).get(packageId, version) as { id: number };
  const versionId = versionRow.id;

  // Parse docs
  let modules: DocsModule[];
  try {
    const raw = readFileSync(docsPath, "utf-8").trim();
    if (!raw || raw === "[]") return null;
    modules = JSON.parse(raw);
    if (!Array.isArray(modules) || modules.length === 0) return null;
  } catch {
    return null;
  }

  const insertModule = db.prepare(
    'INSERT OR IGNORE INTO modules (version_id, name, comment) VALUES (?, ?, ?)',
  );
  const getModuleId = db.prepare(
    'SELECT id FROM modules WHERE version_id = ? AND name = ?',
  );
  const insertUnion = db.prepare(
    'INSERT OR IGNORE INTO unions (module_id, name, comment, args, cases) VALUES (?, ?, ?, ?, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT OR IGNORE INTO aliases (module_id, name, comment, args, type) VALUES (?, ?, ?, ?, ?)',
  );
  const insertValue = db.prepare(
    'INSERT OR IGNORE INTO "values" (module_id, name, comment, type) VALUES (?, ?, ?, ?)',
  );
  const insertBinop = db.prepare(
    'INSERT OR IGNORE INTO binops (module_id, name, comment, type, associativity, precedence) VALUES (?, ?, ?, ?, ?, ?)',
  );

  for (const mod of modules) {
    insertModule.run(versionId, mod.name, mod.comment || "");
    const modRow = getModuleId.get(versionId, mod.name) as { id: number };
    const moduleId = modRow.id;

    for (const u of mod.unions || []) {
      insertUnion.run(moduleId, u.name, u.comment || "", JSON.stringify(u.args || []), JSON.stringify(u.cases || []));
    }
    for (const a of mod.aliases || []) {
      insertAlias.run(moduleId, a.name, a.comment || "", JSON.stringify(a.args || []), a.type);
    }
    for (const v of mod.values || []) {
      insertValue.run(moduleId, v.name, v.comment || "", v.type);
    }
    for (const b of mod.binops || []) {
      insertBinop.run(moduleId, b.name, b.comment || "", b.type, b.associativity, b.precedence);
    }
  }

  return { packageId, versionId, moduleCount: modules.length };
}

// ---------------------------------------------------------------------------
// github*.json → packages status + github table
// ---------------------------------------------------------------------------

interface GithubData {
  fetched_at: string;
  stargazers_count: number;
  last_commit_at: string;
  open_issues: { count: number; min_days: number; max_days: number; avg_days: number };
  open_prs: { count: number; min_days: number; max_days: number; avg_days: number };
}

interface GithubRedirect {
  fetched_at: string;
  redirected_to: string;
}

interface GithubMissing {
  fetched_at: string;
  user_exists: boolean;
}

export function ingestGithubFile(
  db: Database.Database,
  filePath: string,
): void {
  // Derive org/name from path: .../packages/<org>/<name>/github*.json
  const dir = dirname(filePath);
  const rel = relative(PACKAGES_DIR, dir);
  const parts = rel.split("/");
  if (parts.length !== 2) return;
  const [org, name] = parts;

  const file = basename(filePath);

  // Ensure package exists
  let row = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?").get(org, name) as { id: number } | undefined;
  if (!row) {
    db.prepare("INSERT INTO packages (org, name) VALUES (?, ?)").run(org, name);
    row = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?").get(org, name) as { id: number };
  }
  const packageId = row.id;

  const data = JSON.parse(readFileSync(filePath, "utf-8"));

  if (file === "github-redirect.json") {
    const redir = data as GithubRedirect;
    db.prepare("UPDATE packages SET redirect_to = ? WHERE id = ?").run(redir.redirected_to, packageId);
    // Remove any github data row since this is a redirect
    db.prepare("DELETE FROM github WHERE package_id = ?").run(packageId);
  } else if (file === "github-missing.json") {
    const missing = data as GithubMissing;
    const missingType = missing.user_exists ? "package" : "user";
    db.prepare("UPDATE packages SET missing = ? WHERE id = ?").run(missingType, packageId);
    // Remove any github data row
    db.prepare("DELETE FROM github WHERE package_id = ?").run(packageId);
  } else if (file === "github.json") {
    const gh = data as GithubData;
    // Null last_commit_at means the commits endpoint failed — likely a missing repo
    if (gh.last_commit_at == null) return;
    // Clear any previous error state
    db.prepare("UPDATE packages SET redirect_to = NULL, missing = NULL WHERE id = ?").run(packageId);
    db.prepare(`
      INSERT INTO github (package_id, fetched_at, stargazers_count, last_commit_at,
        open_issues_count, open_issues_min_days, open_issues_max_days, open_issues_avg_days,
        open_prs_count, open_prs_min_days, open_prs_max_days, open_prs_avg_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        stargazers_count = excluded.stargazers_count,
        last_commit_at = excluded.last_commit_at,
        open_issues_count = excluded.open_issues_count,
        open_issues_min_days = excluded.open_issues_min_days,
        open_issues_max_days = excluded.open_issues_max_days,
        open_issues_avg_days = excluded.open_issues_avg_days,
        open_prs_count = excluded.open_prs_count,
        open_prs_min_days = excluded.open_prs_min_days,
        open_prs_max_days = excluded.open_prs_max_days,
        open_prs_avg_days = excluded.open_prs_avg_days
    `).run(
      packageId, gh.fetched_at, gh.stargazers_count, gh.last_commit_at,
      gh.open_issues.count, gh.open_issues.min_days, gh.open_issues.max_days, gh.open_issues.avg_days,
      gh.open_prs.count, gh.open_prs.min_days, gh.open_prs.max_days, gh.open_prs.avg_days,
    );
  }
}

// ---------------------------------------------------------------------------
// Version sort
// ---------------------------------------------------------------------------

function computeVersionSort(version: string): number {
  const parts = version.split(".").map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}

// ---------------------------------------------------------------------------
// FTS5 search index
// ---------------------------------------------------------------------------

export function rebuildSearchIndex(db: Database.Database): number {
  db.exec("DELETE FROM search_index");

  // Modules
  db.exec(`
    INSERT INTO search_index (package, module, name, comment, type_sig, kind)
    SELECT p.org || '/' || p.name, m.name, m.name, m.comment, '', 'module'
    FROM modules m
    JOIN package_versions pv ON m.version_id = pv.id
    JOIN packages p ON pv.package_id = p.id
  `);

  // Values
  db.exec(`
    INSERT INTO search_index (package, module, name, comment, type_sig, kind)
    SELECT p.org || '/' || p.name, m.name, v.name, v.comment, v.type, 'value'
    FROM "values" v
    JOIN modules m ON v.module_id = m.id
    JOIN package_versions pv ON m.version_id = pv.id
    JOIN packages p ON pv.package_id = p.id
  `);

  // Unions
  db.exec(`
    INSERT INTO search_index (package, module, name, comment, type_sig, kind)
    SELECT p.org || '/' || p.name, m.name, u.name, u.comment, '', 'union'
    FROM unions u
    JOIN modules m ON u.module_id = m.id
    JOIN package_versions pv ON m.version_id = pv.id
    JOIN packages p ON pv.package_id = p.id
  `);

  // Aliases
  db.exec(`
    INSERT INTO search_index (package, module, name, comment, type_sig, kind)
    SELECT p.org || '/' || p.name, m.name, a.name, a.comment, a.type, 'alias'
    FROM aliases a
    JOIN modules m ON a.module_id = m.id
    JOIN package_versions pv ON m.version_id = pv.id
    JOIN packages p ON pv.package_id = p.id
  `);

  // Binops
  db.exec(`
    INSERT INTO search_index (package, module, name, comment, type_sig, kind)
    SELECT p.org || '/' || p.name, m.name, b.name, b.comment, b.type, 'binop'
    FROM binops b
    JOIN modules m ON b.module_id = m.id
    JOIN package_versions pv ON m.version_id = pv.id
    JOIN packages p ON pv.package_id = p.id
  `);

  const count = (db.prepare("SELECT count(*) as n FROM search_index").get() as { n: number }).n;
  return count;
}
