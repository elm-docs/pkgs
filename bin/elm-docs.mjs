#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, globSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const scriptsDir = resolve(pkgRoot, "scripts");

const ACTIONS = {
  "type-search": { script: "src/TypeSearch.elm", needsDb: true },
  search: { script: "src/TextSearch.elm", needsDb: true },
  "build-db": { script: "src/BuildDb.elm", needsDb: false },
  status: { script: "src/Status.elm", needsDb: false },
  help: { script: null, needsDb: false },
};

const REGISTRY_URL = "https://package.elm-lang.org/all-packages/since/";
const FRESHNESS_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Progress bar for database builds
// ---------------------------------------------------------------------------

const BUILD_STAGES = [
  { pattern: /packages from search\.json/, label: "Indexing packages", pct: 10 },
  { pattern: /new\/changed docs\.json/, label: "Scanning docs", pct: 15 },
  { pattern: /versions ingested/, label: "Ingesting docs", pct: 50 },
  { pattern: /new\/changed github/, label: "Scanning GitHub data", pct: 55 },
  { pattern: /github files ingested/, label: "Ingesting GitHub data", pct: 65 },
  { pattern: /package ranks computed/, label: "Computing rankings", pct: 75 },
  { pattern: /Building type index/, label: "Building type index", pct: 80 },
  { pattern: /type index entries/, label: "Finalizing", pct: 95 },
];

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
  build-db              Build or rebuild the package database
  status                Report sync status of all packages
  help                  Show this help message

Examples:
  elm-docs type-search 'List a -> Maybe a'
  elm-docs type-search 'String -> Int' --limit 10
  elm-docs type-search 'Model -> Html Msg' --project
  elm-docs search 'json parser'
  elm-docs search 'http' --limit 5
  elm-docs search 'animation' --project
  elm-docs build-db --full
  elm-docs status

Database:
  Default location: ~/.elm-docs/elm-packages.db
  Override with --db <path>
  Database is automatically created for search commands.

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

function stripDbFlag(args) {
  const result = [...args];
  const idx = result.indexOf("--db");
  if (idx !== -1) {
    result.splice(idx, idx + 1 < result.length ? 2 : 1);
  }
  return result;
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
// Database creation with progress bar
// ---------------------------------------------------------------------------

function runBuildWithProgress(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveElmPages(),
      ["run", "src/BuildDb.elm", "--", ...args],
      { cwd: scriptsDir, stdio: ["inherit", "pipe", "pipe"] },
    );

    renderProgressBar(0, "Starting");

    let stderrOutput = "";

    const handleOutput = (data) => {
      const text = data.toString();
      for (const stage of BUILD_STAGES) {
        if (stage.pattern.test(text)) {
          renderProgressBar(stage.pct, stage.label);
        }
      }
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
      handleOutput(data);
    });

    child.on("close", (code) => {
      clearProgressBar();
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Database build failed (exit code ${code})${stderrOutput ? "\n" + stderrOutput : ""}`,
          ),
        );
      }
    });
  });
}

async function buildDb(dbPath, extraArgs = []) {
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const label = existsSync(dbPath) ? "Updating" : "Building";
  console.error(`${label} package database...`);
  const start = Date.now();
  await runBuildWithProgress(["--db", dbPath, ...extraArgs]);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`Database ready (${elapsed}s).`);
}

async function ensureDb(dbPath) {
  if (existsSync(dbPath)) return;
  await buildDb(dbPath);
}

// ---------------------------------------------------------------------------
// Freshness check and DB metadata
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
  const count = getDbVersionCount(dbPath);
  if (count === null) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FRESHNESS_TIMEOUT_MS);
    const response = await fetch(`${REGISTRY_URL}${count}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return;
    const newPackages = await response.json();
    if (newPackages.length > 0) {
      console.error(
        `\x1b[33m${newPackages.length} new package version(s) available. Run 'elm-docs build-db' to update.\x1b[0m`,
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

function computeProjectDbPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return resolve(homedir(), ".elm-docs", "projects", hash, "context.db");
}

function getElmJsonSourceDirs(projectRoot) {
  try {
    const data = JSON.parse(readFileSync(join(projectRoot, "elm.json"), "utf-8"));
    if (data.type === "application") {
      return (data["source-directories"] || ["src"]).map((d) => resolve(projectRoot, d));
    }
    return [resolve(projectRoot, "src")];
  } catch {
    return [resolve(projectRoot, "src")];
  }
}

function isProjectDbStale(projectDbPath, projectRoot) {
  if (!existsSync(projectDbPath)) return true;
  const dbMtime = statSync(projectDbPath).mtimeMs;

  // Check elm.json
  const elmJsonPath = join(projectRoot, "elm.json");
  if (statSync(elmJsonPath).mtimeMs > dbMtime) return true;

  // Check source files
  const sourceDirs = getElmJsonSourceDirs(projectRoot);
  for (const srcDir of sourceDirs) {
    if (!existsSync(srcDir)) continue;
    const files = globSync("**/*.elm", { cwd: srcDir });
    for (const f of files) {
      if (statSync(join(srcDir, f)).mtimeMs > dbMtime) return true;
    }
  }

  return false;
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

  if (action.needsDb) {
    await ensureDb(dbPath);
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
  } else if (actionName === "build-db") {
    await buildDb(dbPath, stripDbFlag(actionArgs));
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
