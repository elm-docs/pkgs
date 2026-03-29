#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const scriptsDir = resolve(pkgRoot, "scripts");

const ACTIONS = {
  "type-search": { script: "src/TypeSearch.elm", needsDb: true },
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
  build-db              Build or rebuild the package database
  status                Report sync status of all packages
  help                  Show this help message

Examples:
  elm-docs type-search 'List a -> Maybe a'
  elm-docs type-search 'String -> Int' --limit 10
  elm-docs build-db --full
  elm-docs status

Database:
  Default location: ~/.elm-docs/elm-packages.db
  Override with --db <path>
  Database is automatically created/updated for type-search.`);
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

function contentDir() {
  const candidate = resolve(pkgRoot, "package-elm-lang-org", "content");
  if (existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function isDbStale(dbPath) {
  if (!existsSync(dbPath)) {
    return true;
  }
  const stats = statSync(dbPath);
  return Date.now() - stats.mtimeMs > DB_MAX_AGE_MS;
}

function runElmPages(script, args) {
  execFileSync("elm-pages", ["run", script, "--", ...args], {
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
  const content = contentDir();
  if (content) {
    buildArgs.push("--content-dir", content);
  }

  runElmPages("src/BuildDb.elm", buildArgs);
}

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

  const content = contentDir();
  if (content && !actionArgs.includes("--content-dir")) {
    extraArgs.push("--content-dir", content);
  }

  runElmPages(action.script, [...extraArgs, ...actionArgs]);
}

main();
