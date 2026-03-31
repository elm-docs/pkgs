#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, globSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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

const DB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  Database is automatically created/updated for type-search.

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

function isDbStale(dbPath) {
  if (!existsSync(dbPath)) {
    return true;
  }
  const stats = statSync(dbPath);
  return Date.now() - stats.mtimeMs > DB_MAX_AGE_MS;
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

function ensureDb(dbPath) {
  if (!isDbStale(dbPath)) {
    return;
  }

  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const action = existsSync(dbPath) ? "Updating" : "Building";
  console.log(`${action} package database at ${dbPath}...`);

  const buildArgs = ["--db", dbPath];
  runElmPages("src/BuildDb.elm", buildArgs);
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

function main() {
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
    ensureDb(dbPath);
  }

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
    return;
  }

  // Handle --project flag for type-search
  if (actionName === "type-search") {
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
    return;
  }

  runElmPages(action.script, [...extraArgs, ...actionArgs]);
}

main();
