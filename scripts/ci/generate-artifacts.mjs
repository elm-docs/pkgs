#!/usr/bin/env node

/**
 * Generate release artifacts from a synced SQLite database.
 *
 * Usage:
 *   node scripts/ci/generate-artifacts.mjs --source-db ./elm-packages-sync.db --out ./artifacts [--delta-from 16400]
 *
 * Two-database approach:
 *   - Source DB (elm-packages-sync.db): always compressed and output
 *   - User-facing DB (elm-packages.db): only generated when source DB is complete
 *     (all versions have docs_status='ok')
 *
 * When complete, produces:
 *   - elm-packages-sync.db.zst  (zstd-compressed source DB with sync state)
 *   - elm-packages.db.zst       (zstd-compressed clean DB, sync columns stripped)
 *   - elm-packages-delta.json.zst (docs + type index for versions added since --delta-from)
 *   - metadata.json             (package metadata snapshot)
 *   - manifest.json             (routing info for clients)
 *
 * When incomplete, produces only:
 *   - elm-packages-sync.db.zst  (source DB)
 *   - manifest.json             (updated, but fullDbAt unchanged)
 */

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Database } from "../../lib/sqlite.mjs";

function parseArgs(argv) {
  const args = { sourceDb: null, out: null, deltaFrom: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source-db" && i + 1 < argv.length) args.sourceDb = argv[++i];
    // Keep --db as alias for backwards compat during transition
    else if (argv[i] === "--db" && i + 1 < argv.length) args.sourceDb = argv[++i];
    else if (argv[i] === "--out" && i + 1 < argv.length) args.out = argv[++i];
    else if (argv[i] === "--delta-from" && i + 1 < argv.length) args.deltaFrom = parseInt(argv[++i], 10);
  }
  if (!args.sourceDb || !args.out) {
    console.error("Usage: generate-artifacts.mjs --source-db <path> --out <dir> [--delta-from <count>]");
    process.exit(1);
  }
  return args;
}

async function openDb(dbPath, opts) {
  const db = await Database.open(dbPath, opts || { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

function getVersionCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM package_versions").get().c;
}

function checkCompleteness(db) {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM package_versions WHERE docs_status != 'ok'"
  ).get();
  return { complete: row.c === 0, pending: row.c };
}

async function generateCleanDb(sourceDbPath, outDir) {
  const cleanDbPath = join(outDir, "elm-packages.db");
  copyFileSync(sourceDbPath, cleanDbPath);

  // Open the copy and strip sync-related columns by recreating the tables
  const db = await Database.open(cleanDbPath);
  db.pragma("journal_mode = WAL");

  // Recreate package_versions without sync columns
  db.exec(`
    CREATE TABLE package_versions_clean (
      id           INTEGER PRIMARY KEY,
      package_id   INTEGER NOT NULL REFERENCES packages(id),
      version      TEXT NOT NULL,
      version_sort INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, version)
    )
  `);
  db.exec(`
    INSERT INTO package_versions_clean (id, package_id, version, version_sort)
    SELECT id, package_id, version, version_sort FROM package_versions
  `);
  db.exec("DROP TABLE package_versions");
  db.exec("ALTER TABLE package_versions_clean RENAME TO package_versions");

  // Recreate packages without sync columns
  db.exec(`
    CREATE TABLE packages_clean (
      id          INTEGER PRIMARY KEY,
      org         TEXT NOT NULL,
      name        TEXT NOT NULL,
      summary     TEXT,
      license     TEXT,
      redirect_to TEXT,
      missing     TEXT CHECK(missing IN ('user', 'package')),
      rank        REAL NOT NULL DEFAULT 0,
      UNIQUE(org, name)
    )
  `);
  db.exec(`
    INSERT INTO packages_clean (id, org, name, summary, license, redirect_to, missing, rank)
    SELECT id, org, name, summary, license, redirect_to, missing, rank FROM packages
  `);
  db.exec("DROP TABLE packages");
  db.exec("ALTER TABLE packages_clean RENAME TO packages");

  // Recreate indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_packages_org ON packages(org)");

  db.exec("VACUUM");
  db.close();

  // Compress
  execFileSync("zstd", ["-f", "--rm", cleanDbPath]);
  return cleanDbPath + ".zst";
}

function generateDelta(db, deltaFrom) {
  // Get all version IDs, skip first deltaFrom, take the rest
  const allVersionIds = db.prepare(
    "SELECT id FROM package_versions ORDER BY id"
  ).all().map(r => r.id);

  const newVersionIds = allVersionIds.slice(deltaFrom);
  if (newVersionIds.length === 0) return [];

  const fetchVersion = db.prepare(`
    SELECT pv.id AS version_id, pv.version, p.org, p.name, p.id AS package_id
    FROM package_versions pv
    JOIN packages p ON pv.package_id = p.id
    WHERE pv.id = ?
  `);

  const fetchModules = db.prepare(`
    SELECT m.id, m.name, m.comment FROM modules m WHERE m.version_id = ?
  `);
  const fetchUnions = db.prepare(
    "SELECT name, comment, args, cases FROM unions WHERE module_id = ?"
  );
  const fetchAliases = db.prepare(
    "SELECT name, comment, args, type FROM aliases WHERE module_id = ?"
  );
  const fetchValues = db.prepare(
    'SELECT name, comment, type FROM "values" WHERE module_id = ?'
  );
  const fetchBinops = db.prepare(
    "SELECT name, comment, type, associativity, precedence FROM binops WHERE module_id = ?"
  );
  const fetchTypeIndex = db.prepare(`
    SELECT module_name, name, kind, type_raw, type_ast, fingerprint, arg_count,
           package_id, version_id, major_version, is_latest
    FROM type_index WHERE version_id = ?
  `);

  const delta = [];
  for (const versionId of newVersionIds) {
    const ver = fetchVersion.get(versionId);
    if (!ver) continue;

    const modules = fetchModules.all(versionId).map(mod => {
      return {
        name: mod.name,
        comment: mod.comment,
        unions: fetchUnions.all(mod.id).map(u => ({
          name: u.name, comment: u.comment,
          args: JSON.parse(u.args), cases: JSON.parse(u.cases),
        })),
        aliases: fetchAliases.all(mod.id).map(a => ({
          name: a.name, comment: a.comment,
          args: JSON.parse(a.args), type: a.type,
        })),
        values: fetchValues.all(mod.id).map(v => ({
          name: v.name, comment: v.comment, type: v.type,
        })),
        binops: fetchBinops.all(mod.id).map(b => ({
          name: b.name, comment: b.comment, type: b.type,
          associativity: b.associativity, precedence: b.precedence,
        })),
      };
    });

    const typeIndex = fetchTypeIndex.all(versionId).map(ti => ({
      moduleName: ti.module_name, name: ti.name, kind: ti.kind,
      typeRaw: ti.type_raw, typeAst: ti.type_ast,
      fingerprint: ti.fingerprint, argCount: ti.arg_count,
      packageId: ti.package_id, versionId: ti.version_id,
      majorVersion: ti.major_version, isLatest: ti.is_latest,
    }));

    delta.push({
      org: ver.org, name: ver.name, version: ver.version,
      docs: modules, typeIndex,
    });
  }
  return delta;
}

function generateMetadata(db) {
  return db.prepare(`
    SELECT p.org || '/' || p.name AS package,
           COALESCE(p.summary, '') AS summary,
           COALESCE(p.license, '') AS license,
           p.rank,
           COALESCE(g.stargazers_count, 0) AS stars,
           g.last_commit_at AS lastCommit,
           COALESCE(g.open_issues_count, 0) AS openIssues,
           COALESCE(g.open_prs_count, 0) AS openPrs,
           g.fetched_at AS githubFetchedAt
    FROM packages p
    LEFT JOIN github g ON g.package_id = p.id
    WHERE p.redirect_to IS NULL AND p.missing IS NULL
    ORDER BY p.rank DESC
  `).all();
}

function sha256File(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDbPath = resolve(args.sourceDb);
  const outDir = resolve(args.out);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const db = await openDb(sourceDbPath);
  const versionCount = getVersionCount(db);
  const completeness = checkCompleteness(db);

  console.log(`Database has ${versionCount} package versions`);
  console.log(`Completeness: ${completeness.complete ? "complete" : `incomplete (${completeness.pending} pending/errored)`}`);

  // Always: compress and output source DB
  const sourceOutPath = join(outDir, "elm-packages-sync.db");
  copyFileSync(sourceDbPath, sourceOutPath);
  execFileSync("zstd", ["-f", "--rm", sourceOutPath]);
  const sourceZstPath = sourceOutPath + ".zst";
  console.log(`Source DB: ${sourceZstPath}`);

  if (completeness.complete) {
    // Generate clean user-facing DB
    console.log("Generating clean user-facing database...");
    db.close();
    const cleanDbZstPath = await generateCleanDb(sourceDbPath, outDir);
    console.log(`Clean DB: ${cleanDbZstPath}`);

    // Re-open source DB for delta/metadata generation
    const db2 = await openDb(sourceDbPath);

    // Generate delta
    const deltaFrom = args.deltaFrom ?? versionCount;
    const delta = generateDelta(db2, deltaFrom);
    const deltaPath = join(outDir, "elm-packages-delta.json");
    writeFileSync(deltaPath, JSON.stringify(delta));
    console.log(`Delta: ${delta.length} new versions (since ${deltaFrom})`);
    execFileSync("zstd", ["-f", "--rm", deltaPath]);

    // Generate metadata
    const metadata = generateMetadata(db2);
    const metadataPath = join(outDir, "metadata.json");
    writeFileSync(metadataPath, JSON.stringify(metadata));
    console.log(`Metadata: ${metadata.length} packages`);

    db2.close();

    // Generate manifest
    const cleanDbSize = statSync(cleanDbZstPath).size;
    const deltaZstPath = deltaPath + ".zst";
    const manifest = {
      schemaVersion: 1,
      fullDbAt: versionCount,
      fullDbSha256: sha256File(cleanDbZstPath),
      fullDbSize: cleanDbSize,
      deltaFrom: deltaFrom,
      deltaTo: versionCount,
      deltaSha256: sha256File(deltaZstPath),
      metadataUpdatedAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log("Manifest written (complete)");
  } else {
    db.close();

    // Write a minimal manifest indicating incompleteness
    // Preserve existing fullDbAt if manifest exists
    const existingManifestPath = join(outDir, "manifest.json");
    let existingFullDbAt = 0;
    if (existsSync(existingManifestPath)) {
      try {
        const existing = JSON.parse(readFileSync(existingManifestPath, "utf-8"));
        existingFullDbAt = existing.fullDbAt || 0;
      } catch {}
    }

    const manifest = {
      schemaVersion: 1,
      fullDbAt: existingFullDbAt,
      syncDbAt: versionCount,
      syncPending: completeness.pending,
      metadataUpdatedAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log("Manifest written (incomplete — user-facing artifacts skipped)");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
