#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import { computeProjectDbPath, isProjectDbStale } from "../mcp/project-db.mjs";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const scriptsDir = resolve(pkgRoot, "scripts");

const ACTIONS = {
  "type-search": { script: "src/TypeSearch.elm", needsDb: true },
  search: { script: "src/TextSearch.elm", needsDb: true },
  sync: { script: null, needsDb: false },
  status: { script: "src/Status.elm", needsDb: false },
  mcp: { script: null, needsDb: true },
  help: { script: null, needsDb: false },
};

const RELEASE_BASE = "https://github.com/elm-docs/pkgs/releases/download/packages";
const FRESHNESS_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function renderProgressBar(pct, label) {
  if (!process.stderr.isTTY) return;
  const width = 30;
  const filled = Math.round((width * pct) / 100);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  process.stderr.write(`\r  [${bar}] ${String(pct).padStart(3)}% ${label}  `);
}

function clearProgressBar() {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r${" ".repeat(72)}\r`);
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function defaultDbPath() {
  return resolve(homedir(), ".elm-docs", "elm-packages.db");
}

function printHelp() {
  console.log(`elm-docs - Search and explore Elm packages

Usage: elm-docs <action> [options]

Actions:
  type-search <query>   Search for functions by type signature
  search <query>        Search for packages by keyword
  sync                  Download or update the package database
  status                Report database status
  mcp                   Start an MCP server (for LLM tool use)
  help                  Show this help message

Examples:
  elm-docs type-search 'List a -> Maybe a'
  elm-docs type-search 'String -> Int' --limit 10
  elm-docs type-search 'Model -> Html Msg' --project
  elm-docs search 'json parser'
  elm-docs search 'http' --limit 5
  elm-docs search 'animation' --project
  elm-docs sync
  elm-docs status
  elm-docs mcp

Database:
  Default location: ~/.elm-docs/elm-packages.db
  Override with --db <path>
  Database is automatically downloaded for search commands.

Project scope (--project):
  Restricts results to direct dependencies from the nearest elm.json,
  plus types defined in local source modules.
  --project           Walk up from CWD to find elm.json
  --project <path>    Use elm.json at the given directory`);
}

function parseDbFlag(args) {
  const idx = args.indexOf("--db");
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

function hasDbFlag(args) {
  return args.includes("--db");
}

function resolveElmPages() {
  const local = resolve(pkgRoot, "node_modules", ".bin", "elm-pages");
  if (existsSync(local)) return local;
  return "elm-pages";
}

function runElmPages(script, args) {
  execFileSync(resolveElmPages(), ["run", script, "--", ...args], {
    cwd: scriptsDir,
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// Sync from GitHub Release
// ---------------------------------------------------------------------------

function getDbVersionCount(dbPath) {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    const row = db.prepare("SELECT COUNT(*) as count FROM package_versions").get();
    db.close();
    return row.count;
  } catch {
    return null;
  }
}

async function fetchManifest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FRESHNESS_TIMEOUT_MS);
  try {
    const resp = await fetch(`${RELEASE_BASE}/manifest.json`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function downloadWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);

  const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
  const chunks = [];
  let received = 0;

  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength > 0) {
      const pct = Math.round((received / contentLength) * 100);
      renderProgressBar(pct, label);
    }
  }
  clearProgressBar();

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(result);
}

function computeVersionSort(version) {
  const parts = version.split(".").map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}

function applyDelta(dbPath, deltaEntries) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  try {
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
    const deleteTypeIndex = db.prepare("DELETE FROM type_index WHERE package_id = ?");
    const insertTypeIndex = db.prepare(
      "INSERT INTO type_index (package_id, version_id, module_name, name, kind, type_raw, type_ast, fingerprint, arg_count, major_version, is_latest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    const pkgIdCache = new Map();

    const tx = db.transaction(() => {
      for (const entry of deltaEntries) {
        const pkgKey = `${entry.org}/${entry.name}`;
        let packageId = pkgIdCache.get(pkgKey);
        if (packageId === undefined) {
          const row = upsertPkg.get(entry.org, entry.name);
          packageId = row.id;
          pkgIdCache.set(pkgKey, packageId);
        }

        const versionSort = computeVersionSort(entry.version);
        const versionRow = insertVersion.get(packageId, entry.version, versionSort);
        const versionId = versionRow.id;

        for (const mod of entry.docs || []) {
          const modRow = insertModule.get(versionId, mod.name, mod.comment || "");
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

        // Apply type index entries
        if (entry.typeIndex && entry.typeIndex.length > 0) {
          deleteTypeIndex.run(packageId);
          for (const ti of entry.typeIndex) {
            insertTypeIndex.run(
              ti.packageId, ti.versionId, ti.moduleName, ti.name, ti.kind,
              ti.typeRaw, ti.typeAst, ti.fingerprint, ti.argCount,
              ti.majorVersion ?? 0, ti.isLatest ?? 1,
            );
          }
        }
      }
    });
    tx();
  } finally {
    db.close();
  }
}

function applyMetadata(dbPath, metadataEntries) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const upsert = db.prepare(`
      INSERT INTO packages (org, name, summary, license)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org, name) DO UPDATE SET summary = excluded.summary, license = excluded.license
    `);
    const tx = db.transaction(() => {
      for (const entry of metadataEntries) {
        const [org, name] = entry.package.split("/");
        upsert.run(org, name, entry.summary, entry.license);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

async function syncFromRelease(dbPath) {
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  // 1. Fetch manifest
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (e) {
    if (existsSync(dbPath)) {
      console.error("\x1b[2mWorking offline \u2014 using existing database.\x1b[0m");
      return;
    }
    console.error(`Cannot fetch release manifest: ${e.message}`);
    process.exit(1);
  }

  // 2. Determine strategy
  const localCount = existsSync(dbPath) ? getDbVersionCount(dbPath) : null;

  if (localCount !== null && localCount >= manifest.fullDbAt) {
    console.error("Database is up to date.");
    return;
  }

  const start = Date.now();

  if (localCount === null || localCount < manifest.deltaFrom) {
    // Download full DB
    console.error("Downloading package database...");
    const dbZst = await downloadWithProgress(
      `${RELEASE_BASE}/elm-packages.db.zst`,
      "Downloading",
    );
    const tmpZst = dbPath + ".zst";
    writeFileSync(tmpZst, dbZst);
    execFileSync("zstd", ["-d", "-f", tmpZst, "-o", dbPath]);
    try { execFileSync("rm", [tmpZst]); } catch { /* ignore */ }

    // Also apply metadata
    try {
      console.error("Fetching metadata...");
      const metaResp = await fetch(`${RELEASE_BASE}/metadata.json`);
      if (metaResp.ok) {
        const metadata = await metaResp.json();
        applyMetadata(dbPath, metadata);
      }
    } catch { /* metadata is optional */ }
  } else {
    // Apply delta
    console.error(`Updating database (${manifest.fullDbAt - localCount} new versions)...`);
    const deltaZst = await downloadWithProgress(
      `${RELEASE_BASE}/elm-packages-delta.json.zst`,
      "Downloading delta",
    );
    const tmpDeltaZst = join(dbDir, "delta.json.zst");
    const tmpDelta = join(dbDir, "delta.json");
    writeFileSync(tmpDeltaZst, deltaZst);
    execFileSync("zstd", ["-d", "-f", tmpDeltaZst, "-o", tmpDelta]);
    try { execFileSync("rm", [tmpDeltaZst]); } catch { /* ignore */ }

    const deltaEntries = JSON.parse(readFileSync(tmpDelta, "utf-8"));
    applyDelta(dbPath, deltaEntries);
    try { execFileSync("rm", [tmpDelta]); } catch { /* ignore */ }

    // Apply metadata
    try {
      console.error("Fetching metadata...");
      const metaResp = await fetch(`${RELEASE_BASE}/metadata.json`);
      if (metaResp.ok) {
        const metadata = await metaResp.json();
        applyMetadata(dbPath, metadata);
      }
    } catch { /* metadata is optional */ }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`Database ready (${elapsed}s).`);
}

async function ensureDb(dbPath) {
  if (existsSync(dbPath)) return;
  await syncFromRelease(dbPath);
}

// ---------------------------------------------------------------------------
// Freshness check
// ---------------------------------------------------------------------------

function formatRelativeDate(date) {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins === 1) return "1 minute ago";
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function printDbLastUpdated(dbPath) {
  try {
    const mtime = statSync(dbPath).mtime;
    console.error(`\x1b[2mDatabase last updated: ${formatRelativeDate(mtime)}\x1b[0m`);
  } catch {
    // ignore
  }
}

async function checkFreshness(dbPath) {
  try {
    const manifest = await fetchManifest();
    const localCount = getDbVersionCount(dbPath);
    if (localCount !== null && localCount < manifest.fullDbAt) {
      const newCount = manifest.fullDbAt - localCount;
      console.error(
        `\x1b[33m${newCount} new package version(s) available. Run 'elm-docs sync' to update.\x1b[0m`,
      );
    }
  } catch {
    console.error(
      "\x1b[2mWorking offline \u2014 updates may be available.\x1b[0m",
    );
  }
}

// ---------------------------------------------------------------------------
// Project scope helpers
// ---------------------------------------------------------------------------

function findElmJsonDir(dir) {
  const elmJsonPath = join(dir, "elm.json");
  if (existsSync(elmJsonPath)) return dir;
  const parent = dirname(dir);
  if (parent === dir) {
    console.error("Error: No elm.json found in current directory or any parent directory.");
    process.exit(1);
  }
  return findElmJsonDir(parent);
}

function resolveProjectRoot(args) {
  const idx = args.indexOf("--project");
  if (idx === -1) return null;

  const next = args[idx + 1];
  if (next && !next.startsWith("--")) {
    // --project <path>
    const projectRoot = resolve(next);
    if (!existsSync(join(projectRoot, "elm.json"))) {
      console.error(`Error: No elm.json found at ${projectRoot}`);
      process.exit(1);
    }
    return projectRoot;
  } else {
    // --project (walk up from CWD)
    return findElmJsonDir(process.cwd());
  }
}

function ensureProjectDb(projectDbPath, projectRoot) {
  if (!isProjectDbStale(projectDbPath, projectRoot)) return;

  const dbDir = dirname(projectDbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const action = existsSync(projectDbPath) ? "Updating" : "Building";
  console.log(`${action} project context database...`);

  runElmPages("src/BuildProjectContext.elm", [
    "--project-root", projectRoot,
    "--db", projectDbPath,
  ]);
}

function stripProjectFlag(args) {
  const result = [...args];
  const idx = result.indexOf("--project");
  if (idx === -1) return result;
  if (idx + 1 < result.length && !result[idx + 1].startsWith("--")) {
    result.splice(idx, 2);
  } else {
    result.splice(idx, 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const actionName = args[0];
  const actionArgs = args.slice(1);

  if (!actionName || actionName === "help" || actionName === "--help") {
    printHelp();
    process.exit(0);
  }

  const action = ACTIONS[actionName];
  if (!action) {
    console.error(`Unknown action: ${actionName}`);
    console.error(`Run 'elm-docs help' for usage information.`);
    process.exit(1);
  }

  const dbPath = parseDbFlag(actionArgs) || defaultDbPath();

  // Handle sync action
  if (actionName === "sync") {
    await syncFromRelease(dbPath);
    return;
  }

  if (action.needsDb) {
    await ensureDb(dbPath);
  }

  // Handle mcp action
  if (actionName === "mcp") {
    const { startMcpServer } = await import("../mcp/elm-docs-mcp.mjs");
    await startMcpServer(dbPath);
    return;
  }

  // Start freshness check in background (overlaps with command execution)
  const freshnessPromise = action.needsDb
    ? checkFreshness(dbPath).catch(() => {})
    : null;

  const extraArgs = [];
  if (!hasDbFlag(actionArgs)) {
    extraArgs.push("--db", dbPath);
  }

  // Handle --project flag for search
  if (actionName === "search") {
    const projectRoot = resolveProjectRoot(actionArgs);
    let cleanedArgs = stripProjectFlag(actionArgs);

    if (projectRoot) {
      cleanedArgs = cleanedArgs.concat(["--project-root", projectRoot]);
    }

    runElmPages(action.script, [...extraArgs, ...cleanedArgs]);
  } else if (actionName === "type-search") {
    const projectRoot = resolveProjectRoot(actionArgs);
    let cleanedArgs = stripProjectFlag(actionArgs);

    if (projectRoot) {
      const projectDbPath = computeProjectDbPath(projectRoot);
      ensureProjectDb(projectDbPath, projectRoot);
      cleanedArgs = cleanedArgs.concat([
        "--project-root", projectRoot,
        "--project-db", projectDbPath,
      ]);
    }

    runElmPages(action.script, [...extraArgs, ...cleanedArgs]);
  } else {
    runElmPages(action.script, [...extraArgs, ...actionArgs]);
  }

  // Show DB metadata after command output
  if (freshnessPromise) {
    console.error("");
    printDbLastUpdated(dbPath);
    await freshnessPromise;
  }
}

main().catch((err) => {
  // execFileSync errors already show output via stdio: inherit
  if (err.status !== undefined) {
    process.exit(err.status || 1);
  }
  console.error(err.message);
  process.exit(1);
});
