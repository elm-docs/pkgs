#!/usr/bin/env node

/**
 * Generate release artifacts from a synced SQLite database.
 *
 * Usage:
 *   node scripts/ci/generate-artifacts.mjs --db ./elm-packages.db --out ./artifacts [--delta-from 16400]
 *
 * Produces:
 *   - elm-packages.db.zst       (zstd-compressed full DB)
 *   - elm-packages-delta.json.zst (docs + type index for versions added since --delta-from)
 *   - metadata.json             (package metadata snapshot)
 *   - manifest.json             (routing info for clients)
 */

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { db: null, out: null, deltaFrom: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db" && i + 1 < argv.length) args.db = argv[++i];
    else if (argv[i] === "--out" && i + 1 < argv.length) args.out = argv[++i];
    else if (argv[i] === "--delta-from" && i + 1 < argv.length) args.deltaFrom = parseInt(argv[++i], 10);
  }
  if (!args.db || !args.out) {
    console.error("Usage: generate-artifacts.mjs --db <path> --out <dir> [--delta-from <count>]");
    process.exit(1);
  }
  return args;
}

function openDb(dbPath) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

function getVersionCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM package_versions").get().c;
}

function generateDelta(db, deltaFrom) {
  // Get package versions added after deltaFrom (by rowid/id ordering)
  const versions = db.prepare(`
    SELECT pv.id AS version_id, pv.version, p.org, p.name
    FROM package_versions pv
    JOIN packages p ON pv.package_id = p.id
    WHERE pv.id > (
      SELECT COALESCE(
        (SELECT id FROM package_versions ORDER BY id LIMIT 1 OFFSET ?),
        (SELECT MAX(id) FROM package_versions)
      )
    )
    ORDER BY pv.id
  `).all(deltaFrom);

  // Fallback: if deltaFrom-based query is tricky, use a simpler approach
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
           package_id, version_id
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.db);
  const outDir = resolve(args.out);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const db = openDb(dbPath);
  const versionCount = getVersionCount(db);

  console.log(`Database has ${versionCount} package versions`);

  // 1. Generate delta
  const deltaFrom = args.deltaFrom ?? versionCount; // no delta if not specified
  const delta = generateDelta(db, deltaFrom);
  const deltaPath = join(outDir, "elm-packages-delta.json");
  writeFileSync(deltaPath, JSON.stringify(delta));
  console.log(`Delta: ${delta.length} new versions (since ${deltaFrom})`);

  // Compress delta
  execFileSync("zstd", ["-f", "--rm", deltaPath]);
  const deltaZstPath = deltaPath + ".zst";

  // 2. Generate metadata
  const metadata = generateMetadata(db);
  const metadataPath = join(outDir, "metadata.json");
  writeFileSync(metadataPath, JSON.stringify(metadata));
  console.log(`Metadata: ${metadata.length} packages`);

  db.close();

  // 3. Compress DB
  const dbOutPath = join(outDir, "elm-packages.db");
  execFileSync("cp", [dbPath, dbOutPath]);
  execFileSync("zstd", ["-f", "--rm", dbOutPath]);
  const dbZstPath = dbOutPath + ".zst";
  console.log(`Compressed DB: ${dbZstPath}`);

  // 4. Generate manifest
  const dbSize = statSync(dbZstPath).size;
  const manifest = {
    schemaVersion: 1,
    fullDbAt: versionCount,
    fullDbSha256: sha256File(dbZstPath),
    fullDbSize: dbSize,
    deltaFrom: deltaFrom,
    deltaTo: versionCount,
    deltaSha256: sha256File(deltaZstPath),
    metadataUpdatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Manifest written");
}

main();
