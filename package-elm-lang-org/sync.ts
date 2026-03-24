import { glob } from "node:fs/promises";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGES_DIR, BASE_URL, fileExists, parsePackageString, versionDir } from "./lib/packages.ts";
import type { PackageVersion } from "./lib/packages.ts";
import { green, red, dim, writeLine, formatLabel, printList } from "./lib/term.ts";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    concurrency: { type: "string", short: "c", default: "6" },
    delay: { type: "string", short: "d", default: "100" },
    since: { type: "string", short: "s" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: sync.ts [options]

Options:
  -c, --concurrency <n>      Max parallel downloads (default: 6)
  -d, --delay <ms>           Delay in ms between starting each download (default: 100)
  -s, --since <index>        Start from this index instead of counting local docs.json files
  -h, --help                 Show this help message`);
  process.exit(0);
}

const CONCURRENCY = parseInt(flags.concurrency!, 10);
const DELAY_MS = parseInt(flags.delay!, 10);
const SINCE = flags.since ? parseInt(flags.since, 10) : undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countIndexedDocs(): Promise<number> {
  let count = 0;
  for await (const _ of glob(join(PACKAGES_DIR, "**/docs.json"))) {
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Step 1: Discover new packages and lay down pending state
// ---------------------------------------------------------------------------

async function discoverNewPackages(): Promise<void> {
  const index = SINCE ?? await countIndexedDocs();
  console.log(`${dim("[discover]")} Current index: ${index}${SINCE != null ? " (manual)" : " docs.json files"}`);

  const url = `${BASE_URL}/all-packages/since/${index}`;
  console.log(`${dim("[discover]")} Fetching ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch package list: ${res.status} ${res.statusText}`);
  }

  const packages: string[] = await res.json();
  console.log(`${dim("[discover]")} Found ${packages.length} new package version(s)`);

  let queued = 0;
  for (const raw of packages) {
    const pv = parsePackageString(raw);
    const dir = versionDir(pv);

    if (await fileExists(dir)) continue;

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "docs.json"), "");
    await writeFile(join(dir, "pending"), "");
    queued++;
    writeLine(`${dim("[discover]")} Queued ${formatLabel(pv)}`);
  }

  if (queued > 0) {
    console.log(`\n${dim("[discover]")} Queued ${queued} package(s)`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Fetch all pending packages (parallel + throttled)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOne(pendingPath: string): Promise<{ ok: boolean; pv: PackageVersion }> {
  const dir = dirname(pendingPath);
  const rel = dir.slice(PACKAGES_DIR.length + 1); // "org/pkg/version"
  const [org, pkg, version] = rel.split("/");
  const pv: PackageVersion = { org, pkg, version };

  const docsPath = join(dir, "docs.json");
  const errorsPath = join(dir, "errors.json");
  const url = `${BASE_URL}/packages/${org}/${pkg}/${version}/docs.json`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const body = await res.text();
    await writeFile(docsPath, body);
    await rm(pendingPath);

    if (await fileExists(errorsPath)) {
      await rm(errorsPath);
    }

    return { ok: true, pv };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(docsPath, "");
    await writeFile(errorsPath, JSON.stringify({ url, error: message }, null, 2));
    await rm(pendingPath);

    return { ok: false, pv };
  }
}

async function fetchPending(): Promise<void> {
  const pendingFiles: string[] = [];
  for await (const entry of glob(join(PACKAGES_DIR, "**/pending"))) {
    pendingFiles.push(entry);
  }

  const total = pendingFiles.length;
  console.log(`${dim("[fetch]")} ${total} pending package version(s) to download (concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms)`);

  let completed = 0;
  let failed = 0;
  const failures: PackageVersion[] = [];

  async function worker(items: string[]) {
    for (const pendingPath of items) {
      const result = await fetchOne(pendingPath);
      if (result.ok) {
        completed++;
        writeLine(`${dim("[fetch]")} ${green("✓")} ${formatLabel(result.pv)}`);
      } else {
        failed++;
        failures.push(result.pv);
        writeLine(`${dim("[fetch]")} ${red("✗")} ${formatLabel(result.pv)}`);
      }
      const done = completed + failed;
      const pct = total > 0 ? ((done / total) * 100).toFixed(1) : "0.0";
      writeLine(`${dim("[fetch]")} Progress: ${done}/${total} ${dim(`(${pct}%)`)} (${failed} errors)`);
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  // Split pending files into chunks, one per worker
  const chunks: string[][] = Array.from({ length: CONCURRENCY }, () => []);
  for (let i = 0; i < total; i++) {
    chunks[i % CONCURRENCY].push(pendingFiles[i]);
  }

  await Promise.all(chunks.map((chunk) => worker(chunk)));

  if (total > 0) console.log();
  console.log(`${dim("[fetch]")} Completed: ${green(String(completed))} succeeded, ${red(String(failed))} failed`);

  printList("Packages with errors", red, failures);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`${dim("[sync]")} Starting package sync`);
  await discoverNewPackages();
  await fetchPending();
  console.log(`${dim("[sync]")} Done`);
}

main();
