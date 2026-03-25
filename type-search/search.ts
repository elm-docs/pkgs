import { join } from "node:path";
import Database from "better-sqlite3";
import { searchByType } from "./lib/query.ts";
import { dim, green, bold } from "../package-elm-lang-org/lib/term.ts";

const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");
const jsonOutput = args.includes("--json");

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const dbPath = getArg("--db", join(import.meta.dirname!, "../db/elm-packages.db"));
const limit = parseInt(getArg("--limit", "20"), 10);
const threshold = parseFloat(getArg("--threshold", "0.125"));

if (help) {
  console.log(`Usage: type-search <query> [options]

Options:
  --db <path>     Path to database (default: db/elm-packages.db)
  --limit <n>     Max results (default: 20)
  --threshold <f> Distance threshold (default: 0.125)
  --json          Output as JSON
  --help, -h      Show help

Examples:
  npm run type-search -- "a -> Maybe a"
  npm run type-search -- "(a -> b) -> List a -> List b"
  npm run type-search -- "String -> Int"`);
  process.exit(0);
}

// The query is the first non-flag argument
const query = args.find((a, i) => {
  if (a.startsWith("--")) return false;
  // Skip values of flag arguments
  if (i > 0 && ["--db", "--limit", "--threshold"].includes(args[i - 1])) return false;
  return true;
});

if (!query) {
  console.error("Error: No type query provided. Use --help for usage.");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
db.pragma("journal_mode = WAL");

try {
  const results = searchByType(db, query, { limit, threshold });

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (results.length === 0) {
      console.log("No results found.");
    } else {
      console.log(bold(`Results for: ${query}`));
      console.log();
      for (const r of results) {
        const dist = r.distance.toFixed(3);
        console.log(
          `  ${green(r.module + "." + r.name)} ${dim("(" + r.package + ")")}`,
        );
        console.log(`    ${dim(r.typeRaw)}  ${dim("[" + dist + "]")}`);
      }
      console.log();
      console.log(dim(`${results.length} result(s)`));
    }
  }
} finally {
  db.close();
}
