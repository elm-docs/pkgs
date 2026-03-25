import Database from "better-sqlite3";

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

export function openDb(path: string, full: boolean): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  if (full) {
    for (const table of ALL_TABLES) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
  }

  db.exec(SCHEMA);
  db.exec(TYPE_INDEX_DDL);
  db.exec(SEARCH_INDEX_DDL);

  return db;
}
