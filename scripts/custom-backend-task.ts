import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

interface QueryTypeIndexInput {
  dbPath: string;
  minArgs: number;
  maxArgs: number;
}

interface Context {
  cwd: string;
}

interface TypeIndexRow {
  module_name: string;
  name: string;
  kind: string;
  type_raw: string;
  type_ast: string;
  fingerprint: string;
  org: string;
  pkg_name: string;
}

export async function queryTypeIndex(
  input: QueryTypeIndexInput,
  context: Context,
): Promise<TypeIndexRow[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    const rows = db
      .prepare(
        `SELECT ti.module_name, ti.name, ti.kind, ti.type_raw, ti.type_ast, ti.fingerprint,
                p.org, p.name AS pkg_name
         FROM type_index ti
         JOIN packages p ON ti.package_id = p.id
         WHERE ti.arg_count BETWEEN ? AND ?`,
      )
      .all(input.minArgs, input.maxArgs) as TypeIndexRow[];

    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Build DB handlers
// ---------------------------------------------------------------------------

const ALL_TABLES = [
  "type_index",
  "binops",
  "values",
  "aliases",
  "unions",
  "modules",
  "package_versions",
  "package_tags",
  "github",
  "packages",
  "sync_state",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packages (
    id          INTEGER PRIMARY KEY,
    org         TEXT NOT NULL,
    name        TEXT NOT NULL,
    summary     TEXT,
    license     TEXT,
    redirect_to TEXT,
    missing     TEXT CHECK(missing IN ('user', 'package')),
    rank REAL NOT NULL DEFAULT 0,
    UNIQUE(org, name)
);

CREATE TABLE IF NOT EXISTS github (
    package_id              INTEGER PRIMARY KEY REFERENCES packages(id),
    fetched_at              TEXT NOT NULL,
    stargazers_count        INTEGER NOT NULL,
    last_commit_at          TEXT NOT NULL,
    open_issues_count       INTEGER NOT NULL,
    open_issues_min_days    INTEGER NOT NULL,
    open_issues_max_days    INTEGER NOT NULL,
    open_issues_avg_days    INTEGER NOT NULL,
    open_prs_count          INTEGER NOT NULL,
    open_prs_min_days       INTEGER NOT NULL,
    open_prs_max_days       INTEGER NOT NULL,
    open_prs_avg_days       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS package_tags (
    package_id INTEGER NOT NULL REFERENCES packages(id),
    tag        TEXT NOT NULL,
    PRIMARY KEY(package_id, tag)
);

CREATE TABLE IF NOT EXISTS package_versions (
    id           INTEGER PRIMARY KEY,
    package_id   INTEGER NOT NULL REFERENCES packages(id),
    version      TEXT NOT NULL,
    version_sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE(package_id, version)
);

CREATE TABLE IF NOT EXISTS modules (
    id         INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES package_versions(id),
    name       TEXT NOT NULL,
    comment    TEXT NOT NULL DEFAULT '',
    UNIQUE(version_id, name)
);

CREATE TABLE IF NOT EXISTS unions (
    id        INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES modules(id),
    name      TEXT NOT NULL,
    comment   TEXT NOT NULL DEFAULT '',
    args      TEXT NOT NULL DEFAULT '[]',
    cases     TEXT NOT NULL DEFAULT '[]',
    UNIQUE(module_id, name)
);

CREATE TABLE IF NOT EXISTS aliases (
    id        INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES modules(id),
    name      TEXT NOT NULL,
    comment   TEXT NOT NULL DEFAULT '',
    args      TEXT NOT NULL DEFAULT '[]',
    type      TEXT NOT NULL,
    UNIQUE(module_id, name)
);

CREATE TABLE IF NOT EXISTS "values" (
    id        INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES modules(id),
    name      TEXT NOT NULL,
    comment   TEXT NOT NULL DEFAULT '',
    type      TEXT NOT NULL,
    UNIQUE(module_id, name)
);

CREATE TABLE IF NOT EXISTS binops (
    id            INTEGER PRIMARY KEY,
    module_id     INTEGER NOT NULL REFERENCES modules(id),
    name          TEXT NOT NULL,
    comment       TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL,
    associativity TEXT NOT NULL,
    precedence    INTEGER NOT NULL,
    UNIQUE(module_id, name)
);

CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_packages_org ON packages(org);
CREATE INDEX IF NOT EXISTS idx_package_tags_tag ON package_tags(tag);
CREATE INDEX IF NOT EXISTS idx_github_stars ON github(stargazers_count);
CREATE INDEX IF NOT EXISTS idx_modules_name ON modules(name);
CREATE INDEX IF NOT EXISTS idx_values_name ON "values"(name);
CREATE INDEX IF NOT EXISTS idx_unions_name ON unions(name);
CREATE INDEX IF NOT EXISTS idx_aliases_name ON aliases(name);
`;

const TYPE_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS type_index (
    id          INTEGER PRIMARY KEY,
    package_id  INTEGER NOT NULL REFERENCES packages(id),
    version_id  INTEGER NOT NULL REFERENCES package_versions(id),
    module_name TEXT NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    type_raw    TEXT NOT NULL,
    type_ast    TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    arg_count   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_type_index_fingerprint ON type_index(fingerprint);
CREATE INDEX IF NOT EXISTS idx_type_index_arg_count ON type_index(arg_count);
CREATE INDEX IF NOT EXISTS idx_type_index_package ON type_index(package_id);
`;

// Handler 1: initDb
export async function initDb(
  input: { dbPath: string; full: boolean },
  context: Context,
): Promise<Record<string, never>> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  if (input.full) {
    for (const table of ALL_TABLES) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
  }

  db.exec(SCHEMA);
  db.exec(TYPE_INDEX_DDL);
  db.close();
  return {};
}

function computeVersionSort(version: string): number {
  const parts = version.split(".").map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}

// Handler 6: computePackageRanks
export async function computePackageRanks(
  input: { dbPath: string },
  context: Context,
): Promise<{ count: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const rows = db.prepare(`
      SELECT p.id, p.summary, p.missing,
             COALESCE(g.stargazers_count, 0) AS stars,
             g.last_commit_at,
             COALESCE(g.open_issues_count, 0) AS open_issues
      FROM packages p
      LEFT JOIN github g ON g.package_id = p.id
      WHERE p.redirect_to IS NULL
    `).all() as {
      id: number;
      summary: string | null;
      missing: string | null;
      stars: number;
      last_commit_at: string | null;
      open_issues: number;
    }[];

    const now = Date.now();
    const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
    const THREE_YEARS = 3 * ONE_YEAR;

    const updateRank = db.prepare("UPDATE packages SET rank = ? WHERE id = ?");

    const tx = db.transaction(() => {
      for (const row of rows) {
        let recencyScore = 0.0;
        if (row.last_commit_at) {
          const age = now - new Date(row.last_commit_at).getTime();
          if (age < ONE_YEAR) recencyScore = 1.0;
          else if (age < THREE_YEARS) recencyScore = 0.5;
          else recencyScore = 0.2;
        }

        const rank =
          Math.log10(row.stars + 1) * 50 +
          recencyScore * 30 +
          (row.summary ? 10 : 0) +
          (row.missing === null ? 5 : 0) -
          Math.log10(row.open_issues + 1) * 2;

        updateRank.run(rank, row.id);
      }
    });
    tx();

    return { count: rows.length };
  } finally {
    db.close();
  }
}

// Handler 7: buildTypeIndex
interface TypeIndexEntry {
  packageId: number;
  versionId: number;
  moduleName: string;
  name: string;
  kind: string;
  typeRaw: string;
  typeAstJson: string;
  fingerprint: string;
  argCount: number;
}

export async function buildTypeIndex(
  input: { dbPath: string; full: boolean; entries: TypeIndexEntry[]; deletePackageIds: number[] },
  context: Context,
): Promise<{ inserted: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const deleteStmt = db.prepare("DELETE FROM type_index WHERE package_id = ?");
    const insertStmt = db.prepare(`
      INSERT INTO type_index (package_id, version_id, module_name, name, kind, type_raw, type_ast, fingerprint, arg_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const pkgId of input.deletePackageIds) {
        deleteStmt.run(pkgId);
      }
      for (const e of input.entries) {
        insertStmt.run(
          e.packageId, e.versionId, e.moduleName, e.name, e.kind,
          e.typeRaw, e.typeAstJson, e.fingerprint, e.argCount,
        );
      }
    });
    tx();

    return { inserted: input.entries.length };
  } finally {
    db.close();
  }
}

// Handler 8: getTypeEntriesToIndex
interface PackageTypeEntries {
  packageId: number;
  versionId: number;
  entries: { moduleName: string; name: string; kind: string; typeRaw: string }[];
}

export async function getTypeEntriesToIndex(
  input: { dbPath: string; full: boolean; offset: number; limit: number },
  context: Context,
): Promise<{ packages: PackageTypeEntries[]; hasMore: boolean }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    let packagesToIndex: { package_id: number; version_id: number }[];

    if (input.full) {
      packagesToIndex = db.prepare(`
        SELECT p.id AS package_id, pv.id AS version_id
        FROM packages p
        JOIN package_versions pv ON pv.package_id = p.id
        WHERE pv.version_sort = (
          SELECT MAX(pv2.version_sort)
          FROM package_versions pv2
          WHERE pv2.package_id = p.id
        )
        ORDER BY p.id
        LIMIT ? OFFSET ?
      `).all(input.limit + 1, input.offset) as { package_id: number; version_id: number }[];
    } else {
      packagesToIndex = db.prepare(`
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
        ORDER BY p.id
        LIMIT ? OFFSET ?
      `).all(input.limit + 1, input.offset) as { package_id: number; version_id: number }[];
    }

    const hasMore = packagesToIndex.length > input.limit;
    const slice = packagesToIndex.slice(0, input.limit);

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

    const packages: PackageTypeEntries[] = [];
    for (const pkg of slice) {
      const entries: { moduleName: string; name: string; kind: string; typeRaw: string }[] = [];

      for (const row of fetchValues.all(pkg.version_id) as any[]) {
        entries.push({ moduleName: row.module_name, name: row.name, kind: "value", typeRaw: row.type_raw });
      }
      for (const row of fetchAliases.all(pkg.version_id) as any[]) {
        entries.push({ moduleName: row.module_name, name: row.name, kind: "alias", typeRaw: row.type_raw });
      }
      for (const row of fetchBinops.all(pkg.version_id) as any[]) {
        entries.push({ moduleName: row.module_name, name: row.name, kind: "binop", typeRaw: row.type_raw });
      }

      packages.push({
        packageId: pkg.package_id,
        versionId: pkg.version_id,
        entries,
      });
    }

    return { packages, hasMore };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Direct-to-DB sync handlers
// ---------------------------------------------------------------------------

// Handler: getHighWaterMark
export async function getHighWaterMark(
  input: { dbPath: string },
  context: Context,
): Promise<{ count: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM package_versions").get() as { count: number };
    return { count: row.count };
  } finally {
    db.close();
  }
}

// Handler: upsertDocs
export async function upsertDocs(
  input: { dbPath: string; org: string; name: string; version: string; docsJson: string },
  context: Context,
): Promise<{ modules: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  try {
    let modules: any[] | null = null;
    try {
      const raw = input.docsJson.trim();
      if (raw && raw !== "[]") {
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          modules = data;
        }
      }
    } catch {
      // malformed JSON
    }

    if (!modules) return { modules: 0 };

    const upsertPkg = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?) ON CONFLICT(org, name) DO UPDATE SET org = org RETURNING id",
    );
    const insertVersion = db.prepare(
      "INSERT INTO package_versions (package_id, version, version_sort) VALUES (?, ?, ?) ON CONFLICT(package_id, version) DO UPDATE SET package_id = package_id RETURNING id",
    );
    const insertModule = db.prepare(
      "INSERT INTO modules (version_id, name, comment) VALUES (?, ?, ?) ON CONFLICT(version_id, name) DO UPDATE SET comment = excluded.comment RETURNING id",
    );
    const insertUnion = db.prepare(
      "INSERT OR IGNORE INTO unions (module_id, name, comment, args, cases) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAlias = db.prepare(
      'INSERT OR IGNORE INTO aliases (module_id, name, comment, args, type) VALUES (?, ?, ?, ?, ?)',
    );
    const insertValue = db.prepare(
      'INSERT OR IGNORE INTO "values" (module_id, name, comment, type) VALUES (?, ?, ?, ?)',
    );
    const insertBinop = db.prepare(
      "INSERT OR IGNORE INTO binops (module_id, name, comment, type, associativity, precedence) VALUES (?, ?, ?, ?, ?, ?)",
    );

    let moduleCount = 0;
    const tx = db.transaction(() => {
      const row = upsertPkg.get(input.org, input.name) as { id: number };
      const packageId = row.id;

      const versionSort = computeVersionSort(input.version);
      const versionRow = insertVersion.get(packageId, input.version, versionSort) as { id: number };
      const versionId = versionRow.id;

      for (const mod of modules!) {
        const modRow = insertModule.get(versionId, mod.name, mod.comment || "") as { id: number };
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
        moduleCount++;
      }
    });
    tx();

    return { modules: moduleCount };
  } finally {
    db.close();
  }
}

// Handler: upsertGithubResult
export async function upsertGithubResult(
  input: { dbPath: string; org: string; name: string; resultType: string; data: string },
  context: Context,
): Promise<Record<string, never>> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  try {
    const upsertPkg = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?) ON CONFLICT(org, name) DO UPDATE SET org = org RETURNING id",
    );
    const setRedirect = db.prepare("UPDATE packages SET redirect_to = ? WHERE id = ?");
    const setMissing = db.prepare("UPDATE packages SET missing = ? WHERE id = ?");
    const clearRedirectMissing = db.prepare("UPDATE packages SET redirect_to = NULL, missing = NULL WHERE id = ?");
    const deleteGh = db.prepare("DELETE FROM github WHERE package_id = ?");
    const upsertGh = db.prepare(`
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
    `);

    const parsed = JSON.parse(input.data);

    const tx = db.transaction(() => {
      const row = upsertPkg.get(input.org, input.name) as { id: number };
      const packageId = row.id;

      if (input.resultType === "redirect") {
        setRedirect.run(parsed.redirected_to, packageId);
        deleteGh.run(packageId);
      } else if (input.resultType === "missing") {
        const missingType = parsed.user_exists ? "package" : "user";
        setMissing.run(missingType, packageId);
        deleteGh.run(packageId);
      } else if (input.resultType === "info") {
        if (parsed.last_commit_at == null) return;
        clearRedirectMissing.run(packageId);
        upsertGh.run(
          packageId, parsed.fetched_at, parsed.stargazers_count, parsed.last_commit_at,
          parsed.open_issues.count, parsed.open_issues.min_days, parsed.open_issues.max_days, parsed.open_issues.avg_days,
          parsed.open_prs.count, parsed.open_prs.min_days, parsed.open_prs.max_days, parsed.open_prs.avg_days,
        );
      }
    });
    tx();

    return {};
  } finally {
    db.close();
  }
}

// Handler: getPackagesForGithubSync
export async function getPackagesForGithubSync(
  input: { dbPath: string; force: boolean },
  context: Context,
): Promise<{ org: string; name: string }[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    if (input.force) {
      return db.prepare(`
        SELECT p.org, p.name
        FROM packages p
        WHERE p.redirect_to IS NULL AND p.missing IS NULL
      `).all() as { org: string; name: string }[];
    }

    return db.prepare(`
      SELECT p.org, p.name
      FROM packages p LEFT JOIN github g ON g.package_id = p.id
      WHERE p.redirect_to IS NULL AND p.missing IS NULL
        AND (g.fetched_at IS NULL
          OR (g.last_commit_at > date('now', '-6 months')
              AND g.fetched_at < date('now', '-1 day'))
          OR g.fetched_at < date('now', '-7 days'))
    `).all() as { org: string; name: string }[];
  } finally {
    db.close();
  }
}

// Handler: ingestSearchJsonBody
export async function ingestSearchJsonBody(
  input: { dbPath: string; body: string },
  context: Context,
): Promise<{ count: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    const entries = JSON.parse(input.body);
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
    return { count: entries.length };
  } finally {
    db.close();
  }
}

// Handler: getDbStatus
export async function getDbStatus(
  input: { dbPath: string },
  context: Context,
): Promise<{
  totalPackages: number;
  totalVersions: number;
  withGithub: number;
  redirected: number;
  missing: number;
  typeIndexed: number;
}> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    const totalPackages = (db.prepare("SELECT COUNT(*) AS c FROM packages").get() as { c: number }).c;
    const totalVersions = (db.prepare("SELECT COUNT(*) AS c FROM package_versions").get() as { c: number }).c;
    const withGithub = (db.prepare("SELECT COUNT(*) AS c FROM github").get() as { c: number }).c;
    const redirected = (db.prepare("SELECT COUNT(*) AS c FROM packages WHERE redirect_to IS NOT NULL").get() as { c: number }).c;
    const missing = (db.prepare("SELECT COUNT(*) AS c FROM packages WHERE missing IS NOT NULL").get() as { c: number }).c;
    const typeIndexed = (db.prepare("SELECT COUNT(DISTINCT package_id) AS c FROM type_index").get() as { c: number }).c;
    return { totalPackages, totalVersions, withGithub, redirected, missing, typeIndexed };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Project context handlers
// ---------------------------------------------------------------------------

// Handler 9: readProjectInfo
interface ProjectInfoResult {
  projectType: string;
  name: string;
  version: string;
  directDeps: string[];
  sourceDirs: string[];
}

export async function readProjectInfo(
  input: { projectRoot: string },
  context: Context,
): Promise<ProjectInfoResult> {
  const projectRoot = resolve(context.cwd, input.projectRoot);
  const elmJsonPath = join(projectRoot, "elm.json");
  const elmJson = JSON.parse(readFileSync(elmJsonPath, "utf-8"));

  if (elmJson.type === "application") {
    const directDeps = Object.keys(elmJson.dependencies?.direct || {});
    const sourceDirs = (elmJson["source-directories"] || ["src"]).map(
      (d: string) => resolve(projectRoot, d),
    );
    return {
      projectType: "application",
      name: "local/app",
      version: "1.0.0",
      directDeps,
      sourceDirs,
    };
  } else if (elmJson.type === "package") {
    const directDeps = Object.keys(elmJson.dependencies || {});
    return {
      projectType: "package",
      name: elmJson.name,
      version: elmJson.version,
      directDeps,
      sourceDirs: [resolve(projectRoot, "src")],
    };
  } else {
    throw new Error(`Unknown elm.json type: ${elmJson.type}`);
  }
}

// Handler 10: generateLocalDocs
export async function generateLocalDocs(
  input: { projectRoot: string },
  context: Context,
): Promise<{ docsPath: string | null; error: string | null }> {
  const projectRoot = resolve(context.cwd, input.projectRoot);
  const elmJsonPath = join(projectRoot, "elm.json");
  const elmJson = JSON.parse(readFileSync(elmJsonPath, "utf-8"));

  const tmpDir = mkdtempSync(join(tmpdir(), "elm-docs-"));
  const docsPath = join(tmpDir, "docs.json");

  try {
    if (elmJson.type === "package") {
      execFileSync("elm", ["make", "--docs", docsPath], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } else {
      // Use elm-doc-preview for applications
      const edp = resolve(context.cwd, "..", "node_modules", ".bin", "elm-doc-preview");
      execFileSync(edp, ["--output", tmpDir, "--no-server"], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    }
    return { docsPath, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { docsPath: null, error: msg };
  }
}

// Handler 11: ingestLocalDocsJson
export async function ingestLocalDocsJson(
  input: { dbPath: string; docsJsonPath: string; packageName: string; version: string },
  context: Context,
): Promise<{ modules: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const docsJsonPath = resolve(context.cwd, input.docsJsonPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const parts = input.packageName.split("/");
  const org = parts[0] || "local";
  const name = parts[1] || "app";

  try {
    const raw = readFileSync(docsJsonPath, "utf-8").trim();
    const modules: any[] = JSON.parse(raw);

    const upsertPkg = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?) ON CONFLICT(org, name) DO NOTHING",
    );
    const getPkgId = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?");
    const insertVersion = db.prepare(
      "INSERT OR IGNORE INTO package_versions (package_id, version, version_sort) VALUES (?, ?, ?)",
    );
    const getVersionId = db.prepare(
      "SELECT id FROM package_versions WHERE package_id = ? AND version = ?",
    );
    const insertModule = db.prepare(
      "INSERT OR IGNORE INTO modules (version_id, name, comment) VALUES (?, ?, ?)",
    );
    const getModuleId = db.prepare(
      "SELECT id FROM modules WHERE version_id = ? AND name = ?",
    );
    const insertUnion = db.prepare(
      "INSERT OR IGNORE INTO unions (module_id, name, comment, args, cases) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAlias = db.prepare(
      "INSERT OR IGNORE INTO aliases (module_id, name, comment, args, type) VALUES (?, ?, ?, ?, ?)",
    );
    const insertValue = db.prepare(
      'INSERT OR IGNORE INTO "values" (module_id, name, comment, type) VALUES (?, ?, ?, ?)',
    );
    const insertBinop = db.prepare(
      "INSERT OR IGNORE INTO binops (module_id, name, comment, type, associativity, precedence) VALUES (?, ?, ?, ?, ?, ?)",
    );

    let moduleCount = 0;

    const tx = db.transaction(() => {
      upsertPkg.run(org, name);
      const pkgRow = getPkgId.get(org, name) as { id: number };
      const packageId = pkgRow.id;

      const versionSort = computeVersionSort(input.version);
      insertVersion.run(packageId, input.version, versionSort);
      const versionRow = getVersionId.get(packageId, input.version) as { id: number };
      const versionId = versionRow.id;

      for (const mod of modules) {
        insertModule.run(versionId, mod.name, mod.comment || "");
        const modRow = getModuleId.get(versionId, mod.name) as { id: number };
        const moduleId = modRow.id;

        for (const u of mod.unions || []) {
          insertUnion.run(
            moduleId, u.name, u.comment || "",
            JSON.stringify(u.args || []), JSON.stringify(u.cases || []),
          );
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
        moduleCount++;
      }
    });
    tx();

    return { modules: moduleCount };
  } finally {
    db.close();
  }
}

// Handler 12: queryTypeIndexFiltered
interface QueryTypeIndexFilteredInput {
  dbPath: string;
  minArgs: number;
  maxArgs: number;
  allowedPackages: string[] | null;
}

export async function queryTypeIndexFiltered(
  input: QueryTypeIndexFilteredInput,
  context: Context,
): Promise<TypeIndexRow[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    if (!input.allowedPackages || input.allowedPackages.length === 0) {
      return db
        .prepare(
          `SELECT ti.module_name, ti.name, ti.kind, ti.type_raw, ti.type_ast, ti.fingerprint,
                  p.org, p.name AS pkg_name
           FROM type_index ti
           JOIN packages p ON ti.package_id = p.id
           WHERE ti.arg_count BETWEEN ? AND ?`,
        )
        .all(input.minArgs, input.maxArgs) as TypeIndexRow[];
    }

    const placeholders = input.allowedPackages.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT ti.module_name, ti.name, ti.kind, ti.type_raw, ti.type_ast, ti.fingerprint,
                p.org, p.name AS pkg_name
         FROM type_index ti
         JOIN packages p ON ti.package_id = p.id
         WHERE ti.arg_count BETWEEN ? AND ?
           AND (p.org || '/' || p.name) IN (${placeholders})`,
      )
      .all(input.minArgs, input.maxArgs, ...input.allowedPackages) as TypeIndexRow[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Text search handlers
// ---------------------------------------------------------------------------

interface PackageSearchRow {
  package: string;
  summary: string;
  rank: number;
  stars: number;
}

function buildSearchQuery(
  terms: string[],
  extraWhere?: string,
): { sql: string; params: Record<string, string | number> } {
  const likeClauses = terms.map(
    (_: string, i: number) =>
      `LOWER(p.org || ' ' || p.name || ' ' || COALESCE(p.summary, '')) LIKE @term${i}`,
  );
  const params: Record<string, string | number> = {};
  terms.forEach((t: string, i: number) => {
    params[`term${i}`] = `%${t.toLowerCase()}%`;
  });

  const sql = `
SELECT p.org || '/' || p.name AS package,
       COALESCE(p.summary, '') AS summary,
       p.rank,
       COALESCE(g.stargazers_count, 0) AS stars
FROM packages p
LEFT JOIN github g ON g.package_id = p.id
WHERE p.redirect_to IS NULL AND p.missing IS NULL
  ${likeClauses.map((c) => `AND ${c}`).join("\n  ")}
  ${extraWhere || ""}
ORDER BY p.rank DESC
LIMIT @limit
`;
  return { sql, params };
}

// Handler 13: searchPackages
export async function searchPackages(
  input: { dbPath: string; query: string; limit: number },
  context: Context,
): Promise<PackageSearchRow[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    const terms = input.query.trim().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return [];
    const { sql, params } = buildSearchQuery(terms);
    params.limit = input.limit;
    return db.prepare(sql).all(params) as PackageSearchRow[];
  } finally {
    db.close();
  }
}

// Handler 14: searchPackagesFiltered
export async function searchPackagesFiltered(
  input: { dbPath: string; query: string; limit: number; allowedPackages: string[] | null },
  context: Context,
): Promise<PackageSearchRow[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    const terms = input.query.trim().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return [];

    let extraWhere: string | undefined;
    if (input.allowedPackages && input.allowedPackages.length > 0) {
      const placeholders = input.allowedPackages.map((_: string, i: number) => `@pkg${i}`).join(", ");
      extraWhere = `AND (p.org || '/' || p.name) IN (${placeholders})`;
      const { sql, params } = buildSearchQuery(terms, extraWhere);
      params.limit = input.limit;
      input.allowedPackages.forEach((pkg: string, i: number) => { params[`pkg${i}`] = pkg; });
      return db.prepare(sql).all(params) as PackageSearchRow[];
    }

    const { sql, params } = buildSearchQuery(terms);
    params.limit = input.limit;
    return db.prepare(sql).all(params) as PackageSearchRow[];
  } finally {
    db.close();
  }
}
