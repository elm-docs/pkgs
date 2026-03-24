import { stat } from "node:fs/promises";
import { join } from "node:path";

const CONTENT_DIR = join(import.meta.dirname!, "content");
const PACKAGES_DIR = join(CONTENT_DIR, "packages");
const BASE_URL = "https://package.elm-lang.org";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface PackageVersion {
  org: string;
  pkg: string;
  version: string;
}

function parsePackageString(raw: string): PackageVersion {
  const [orgPkg, version] = raw.split("@");
  const [org, pkg] = orgPkg.split("/");
  return { org, pkg, version };
}

function versionDir({ org, pkg, version }: PackageVersion): string {
  return join(PACKAGES_DIR, org, pkg, version);
}

type Status = "success" | "failure" | "pending" | "missing";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// Classify each package
// ---------------------------------------------------------------------------

async function classifyPackage(pv: PackageVersion): Promise<Status> {
  const dir = versionDir(pv);

  if (!(await fileExists(dir))) return "missing";

  const pendingPath = join(dir, "pending");
  if (await fileExists(pendingPath)) return "pending";

  const errorsPath = join(dir, "errors.json");
  if (await fileExists(errorsPath)) return "failure";

  const docsPath = join(dir, "docs.json");
  if (await fileExists(docsPath)) return "success";

  return "missing";
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MAX_DISPLAY = 5;

function formatLabel(pv: PackageVersion): string {
  return `${pv.org}/${pv.pkg}@${pv.version}`;
}

function printList(title: string, color: (s: string) => string, items: PackageVersion[]): void {
  if (items.length === 0) return;

  console.log();
  console.log(color(bold(title)));
  const shown = items.slice(0, MAX_DISPLAY);
  for (const pv of shown) {
    console.log(`  ${dim("•")} ${formatLabel(pv)}`);
  }
  const remaining = items.length - shown.length;
  if (remaining > 0) {
    console.log(dim(`  … and ${remaining} more`));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(dim("Fetching all packages from registry…"));

  const url = `${BASE_URL}/all-packages/since/0`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch package list: ${res.status} ${res.statusText}`);
  }

  const allPackages: string[] = await res.json();
  const total = allPackages.length;

  console.log(dim(`Classifying ${total} packages…\n`));

  const successList: PackageVersion[] = [];
  const failureList: PackageVersion[] = [];
  const pendingList: PackageVersion[] = [];
  const missingList: PackageVersion[] = [];

  // Classify all packages in parallel batches
  const parsed = allPackages.map(parsePackageString);
  const results = await Promise.all(
    parsed.map(async (pv) => ({ pv, status: await classifyPackage(pv) }))
  );

  for (const { pv, status } of results) {
    switch (status) {
      case "success": successList.push(pv); break;
      case "failure": failureList.push(pv); break;
      case "pending": pendingList.push(pv); break;
      case "missing":  missingList.push(pv); break;
    }
  }

  const pct = total > 0 ? ((successList.length / total) * 100).toFixed(1) : "0.0";

  // Summary
  console.log(bold("Package Sync Status"));
  console.log("─".repeat(40));
  console.log(`  Total packages:  ${bold(String(total))}`);
  console.log(`  ${green("✓")} Synced:        ${bold(String(successList.length))} ${dim(`(${pct}%)`)}`);
  console.log(`  ${yellow("◷")} Pending:       ${bold(String(pendingList.length))}`);
  console.log(`  ${red("✗")} Errors:        ${bold(String(failureList.length))}`);
  console.log(`  ${dim("○")} Missing:       ${bold(String(missingList.length))}`);

  // Detail lists
  printList("Pending packages", yellow, pendingList);
  printList("Packages with errors", red, failureList);
  printList("Missing packages", dim, missingList);

  console.log();
}

main();
