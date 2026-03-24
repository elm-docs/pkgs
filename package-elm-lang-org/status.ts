import { join } from "node:path";
import { BASE_URL, fileExists, parsePackageString, versionDir } from "./lib/packages.ts";
import type { PackageVersion } from "./lib/packages.ts";
import { bold, green, red, yellow, dim, printList } from "./lib/term.ts";

type Status = "success" | "failure" | "pending" | "missing";

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
