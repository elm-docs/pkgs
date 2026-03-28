import { resolve, dirname, basename, join } from "node:path";
import { readFileSync, statSync, globSync } from "node:fs";
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
  "_search_index_versions",
  "search_index",
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
  "_build_meta",
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

CREATE TABLE IF NOT EXISTS _build_meta (
    file_path  TEXT PRIMARY KEY,
    mtime_ms   INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL
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

const SEARCH_INDEX_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    package,
    module,
    name,
    comment,
    type_sig,
    kind,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS _search_index_versions (
    package_id INTEGER NOT NULL,
    version_id INTEGER NOT NULL,
    PRIMARY KEY(package_id)
);
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
  db.exec(SEARCH_INDEX_DDL);
  db.close();
  return {};
}

// Handler 2: ingestSearchJson
export async function ingestSearchJson(
  input: { dbPath: string; searchJsonPath: string },
  context: Context,
): Promise<{ count: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const searchJsonPath = resolve(context.cwd, input.searchJsonPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    const entries = JSON.parse(readFileSync(searchJsonPath, "utf-8"));
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

// Handler 3: findChangedFiles
export async function findChangedFiles(
  input: { dbPath: string; contentDir: string; glob: string },
  context: Context,
): Promise<{ relative: string; absolute: string; mtimeMs: number; size: number }[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const contentDir = resolve(context.cwd, input.contentDir);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const files = globSync(input.glob, { cwd: contentDir }) as string[];
    const getMeta = db.prepare(
      "SELECT mtime_ms, size_bytes FROM _build_meta WHERE file_path = ?",
    );

    const changed: { relative: string; absolute: string; mtimeMs: number; size: number }[] = [];
    for (const rel of files) {
      const abs = join(contentDir, rel);
      const st = statSync(abs);
      const row = getMeta.get(rel) as
        | { mtime_ms: number; size_bytes: number }
        | undefined;
      if (!row || row.mtime_ms !== Math.floor(st.mtimeMs) || row.size_bytes !== st.size) {
        changed.push({
          relative: rel,
          absolute: abs,
          mtimeMs: Math.floor(st.mtimeMs),
          size: st.size,
        });
      }
    }
    return changed;
  } finally {
    db.close();
  }
}

// Handler 4: ingestDocsJsonBatch
interface FileRef {
  absolute: string;
  relative: string;
  mtimeMs: number;
  size: number;
}

function computeVersionSort(version: string): number {
  const parts = version.split(".").map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}

export async function ingestDocsJsonBatch(
  input: { dbPath: string; files: FileRef[] },
  context: Context,
): Promise<{ ingested: number; modules: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  let ingested = 0;
  let moduleCount = 0;

  try {
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
      'INSERT OR IGNORE INTO aliases (module_id, name, comment, args, type) VALUES (?, ?, ?, ?, ?)',
    );
    const insertValue = db.prepare(
      'INSERT OR IGNORE INTO "values" (module_id, name, comment, type) VALUES (?, ?, ?, ?)',
    );
    const insertBinop = db.prepare(
      "INSERT OR IGNORE INTO binops (module_id, name, comment, type, associativity, precedence) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const recordMeta = db.prepare(
      `INSERT INTO _build_meta (file_path, mtime_ms, size_bytes)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes`,
    );

    const tx = db.transaction(() => {
      for (const f of input.files) {
        // Derive org/name/version from relative path: packages/<org>/<name>/<version>/docs.json
        const parts = f.relative.split("/");
        if (parts.length < 4) continue;
        const [, org, name, version] = parts;

        upsertPkg.run(org, name);
        const pkgRow = getPkgId.get(org, name) as { id: number };
        const packageId = pkgRow.id;

        const versionSort = computeVersionSort(version);
        insertVersion.run(packageId, version, versionSort);
        const versionRow = getVersionId.get(packageId, version) as { id: number };
        const versionId = versionRow.id;

        let modules: any[];
        try {
          const raw = readFileSync(f.absolute, "utf-8").trim();
          if (!raw || raw === "[]") {
            recordMeta.run(f.relative, f.mtimeMs, f.size);
            continue;
          }
          modules = JSON.parse(raw);
          if (!Array.isArray(modules) || modules.length === 0) {
            recordMeta.run(f.relative, f.mtimeMs, f.size);
            continue;
          }
        } catch {
          recordMeta.run(f.relative, f.mtimeMs, f.size);
          continue;
        }

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

        moduleCount += modules.length;

        ingested++;
        recordMeta.run(f.relative, f.mtimeMs, f.size);
      }
    });
    tx();

    return { ingested, modules: moduleCount };
  } finally {
    db.close();
  }
}

// Handler 5: ingestGithubBatch
export async function ingestGithubBatch(
  input: { dbPath: string; files: FileRef[] },
  context: Context,
): Promise<{ ingested: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  let ingested = 0;

  try {
    const upsertPkg = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?) ON CONFLICT(org, name) DO NOTHING",
    );
    const getPkgId = db.prepare("SELECT id FROM packages WHERE org = ? AND name = ?");
    const recordMeta = db.prepare(
      `INSERT INTO _build_meta (file_path, mtime_ms, size_bytes)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes`,
    );

    const tx = db.transaction(() => {
      for (const f of input.files) {
        // Derive org/name from relative path: packages/<org>/<name>/github*.json
        const dir = dirname(f.relative);
        const parts = dir.split("/");
        if (parts.length < 3) continue;
        const org = parts[1];
        const name = parts[2];
        const file = basename(f.relative);

        upsertPkg.run(org, name);
        const pkgRow = getPkgId.get(org, name) as { id: number };
        const packageId = pkgRow.id;

        const data = JSON.parse(readFileSync(f.absolute, "utf-8"));

        if (file === "github-redirect.json") {
          db.prepare("UPDATE packages SET redirect_to = ? WHERE id = ?").run(data.redirected_to, packageId);
          db.prepare("DELETE FROM github WHERE package_id = ?").run(packageId);
        } else if (file === "github-missing.json") {
          const missingType = data.user_exists ? "package" : "user";
          db.prepare("UPDATE packages SET missing = ? WHERE id = ?").run(missingType, packageId);
          db.prepare("DELETE FROM github WHERE package_id = ?").run(packageId);
        } else if (file === "github.json") {
          if (data.last_commit_at == null) {
            recordMeta.run(f.relative, f.mtimeMs, f.size);
            continue;
          }
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
            packageId, data.fetched_at, data.stargazers_count, data.last_commit_at,
            data.open_issues.count, data.open_issues.min_days, data.open_issues.max_days, data.open_issues.avg_days,
            data.open_prs.count, data.open_prs.min_days, data.open_prs.max_days, data.open_prs.avg_days,
          );
        }

        ingested++;
        recordMeta.run(f.relative, f.mtimeMs, f.size);
      }
    });
    tx();

    return { ingested };
  } finally {
    db.close();
  }
}

// Handler 6: rebuildSearchIndex
export async function rebuildSearchIndex(
  input: { dbPath: string; full: boolean },
  context: Context,
): Promise<{ count: number }> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const changed = db.prepare(`
      SELECT p.id AS package_id, pv.id AS version_id
      FROM packages p
      JOIN package_versions pv ON pv.package_id = p.id
      WHERE pv.version_sort = (
        SELECT MAX(pv2.version_sort)
        FROM package_versions pv2
        WHERE pv2.package_id = p.id
      )
      AND pv.id NOT IN (
        SELECT siv.version_id
        FROM _search_index_versions siv
        WHERE siv.package_id = p.id
      )
    `).all();

    if (!input.full && changed.length === 0) {
      const count = (db.prepare("SELECT count(*) as n FROM search_index").get() as { n: number }).n;
      return { count };
    }

    db.exec("DELETE FROM search_index");
    db.exec("DELETE FROM _search_index_versions");

    const LATEST = `
      WHERE pv.version_sort = (
        SELECT MAX(pv2.version_sort)
        FROM package_versions pv2
        WHERE pv2.package_id = pv.package_id
      )`;

    // Modules
    db.exec(`
      INSERT INTO search_index (package, module, name, comment, type_sig, kind)
      SELECT p.org || '/' || p.name, m.name, m.name, m.comment, '', 'module'
      FROM modules m
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${LATEST}
    `);

    // Values
    db.exec(`
      INSERT INTO search_index (package, module, name, comment, type_sig, kind)
      SELECT p.org || '/' || p.name, m.name, v.name, v.comment, v.type, 'value'
      FROM "values" v
      JOIN modules m ON v.module_id = m.id
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${LATEST}
    `);

    // Unions
    db.exec(`
      INSERT INTO search_index (package, module, name, comment, type_sig, kind)
      SELECT p.org || '/' || p.name, m.name, u.name, u.comment, '', 'union'
      FROM unions u
      JOIN modules m ON u.module_id = m.id
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${LATEST}
    `);

    // Aliases
    db.exec(`
      INSERT INTO search_index (package, module, name, comment, type_sig, kind)
      SELECT p.org || '/' || p.name, m.name, a.name, a.comment, a.type, 'alias'
      FROM aliases a
      JOIN modules m ON a.module_id = m.id
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${LATEST}
    `);

    // Binops
    db.exec(`
      INSERT INTO search_index (package, module, name, comment, type_sig, kind)
      SELECT p.org || '/' || p.name, m.name, b.name, b.comment, b.type, 'binop'
      FROM binops b
      JOIN modules m ON b.module_id = m.id
      JOIN package_versions pv ON m.version_id = pv.id
      JOIN packages p ON pv.package_id = p.id
      ${LATEST}
    `);

    // Record which versions are now indexed
    db.exec(`
      INSERT INTO _search_index_versions (package_id, version_id)
      SELECT p.id, pv.id
      FROM packages p
      JOIN package_versions pv ON pv.package_id = p.id
      WHERE pv.version_sort = (
        SELECT MAX(pv2.version_sort)
        FROM package_versions pv2
        WHERE pv2.package_id = p.id
      )
    `);

    const count = (db.prepare("SELECT count(*) as n FROM search_index").get() as { n: number }).n;
    return { count };
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
