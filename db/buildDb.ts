import { join } from "node:path";
import { CONTENT_DIR } from "../package-elm-lang-org/lib/packages.ts";
import { dim, green, writeLine } from "../package-elm-lang-org/lib/term.ts";
import { openDb } from "./lib/db.ts";
import { findChangedFiles, recordFile } from "./lib/changes.ts";
import {
  ingestSearchJson,
  ingestDocsJson,
  ingestGithubFile,
  rebuildSearchIndex,
} from "./lib/ingest.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const full = args.includes("--full");
const help = args.includes("--help") || args.includes("-h");

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const dbPath = getArg("--db", join(import.meta.dirname!, "elm-packages.db"));

if (help) {
  console.log(`Usage: build-db [options]

Options:
  --full        Drop and rebuild the entire database
  --db <path>   Path to output database (default: db/elm-packages.db)
  --help, -h    Show this help`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(full ? "Full rebuild" : "Incremental build");
console.log(dim(`Database: ${dbPath}`));
console.log();

const db = openDb(dbPath, full);

// 1. search.json → packages
const searchPath = join(CONTENT_DIR, "search.json");
writeLine("Ingesting search.json...");
const packageCount = ingestSearchJson(db, searchPath);
console.log(green(`  ${packageCount} packages from search.json`));

// 2. docs.json files
writeLine("Scanning docs.json files...");
const docsFiles = findChangedFiles(db, CONTENT_DIR, "packages/**/docs.json");
console.log(dim(`  ${docsFiles.length} new/changed docs.json files`));

let docsIngested = 0;
let modulesIngested = 0;
const ingestDocsTx = db.transaction(() => {
  for (let i = 0; i < docsFiles.length; i++) {
    const f = docsFiles[i];
    if (i % 100 === 0) {
      writeLine(`  Ingesting docs ${i + 1}/${docsFiles.length}...`);
    }
    const result = ingestDocsJson(db, f.absolute);
    if (result) {
      docsIngested++;
      modulesIngested += result.moduleCount;
    }
    recordFile(db, f.relative, f.mtimeMs, f.size);
  }
});
ingestDocsTx();

if (docsFiles.length > 0) {
  writeLine("");
  console.log(green(`  ${docsIngested} versions ingested (${modulesIngested} modules)`));
}

// 3. github*.json files
writeLine("Scanning github files...");
const githubFiles = findChangedFiles(db, CONTENT_DIR, "packages/**/github*.json");
console.log(dim(`  ${githubFiles.length} new/changed github files`));

let githubIngested = 0;
const ingestGithubTx = db.transaction(() => {
  for (let i = 0; i < githubFiles.length; i++) {
    const f = githubFiles[i];
    if (i % 100 === 0) {
      writeLine(`  Ingesting github ${i + 1}/${githubFiles.length}...`);
    }
    ingestGithubFile(db, f.absolute);
    githubIngested++;
    recordFile(db, f.relative, f.mtimeMs, f.size);
  }
});
ingestGithubTx();

if (githubFiles.length > 0) {
  writeLine("");
  console.log(green(`  ${githubIngested} github files ingested`));
}

// 4. Rebuild search index
writeLine("Rebuilding search index...");
const searchCount = rebuildSearchIndex(db);
writeLine("");
console.log(green(`  ${searchCount} search index entries`));

// 5. Summary
db.close();
console.log();
console.log(green("Done."));
