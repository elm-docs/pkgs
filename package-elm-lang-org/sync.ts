import { glob } from "node:fs/promises";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const CONTENT_DIR = join(import.meta.dirname!, "content");
const PACKAGES_DIR = join(CONTENT_DIR, "packages");
const BASE_URL = "https://package.elm-lang.org";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    concurrency: { type: "string", short: "c", default: "6" },
    delay: { type: "string", short: "d", default: "100" },
    "max-packages": { type: "string", short: "m" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: sync.ts [options]

Options:
  -c, --concurrency <n>      Max parallel downloads (default: 6)
  -d, --delay <ms>           Delay in ms between starting each download (default: 100)
  -m, --max-packages <n>     Only process the first n packages from the API (default: all)
  -h, --help                 Show this help message`);
  process.exit(0);
}

const CONCURRENCY = parseInt(flags.concurrency!, 10);
const DELAY_MS = parseInt(flags.delay!, 10);
const MAX_PACKAGES = flags["max-packages"] ? parseInt(flags["max-packages"], 10) : undefined;

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
  // format: "org/package@version"
  const [orgPkg, version] = raw.split("@");
  const [org, pkg] = orgPkg.split("/");
  return { org, pkg, version };
}

function versionDir({ org, pkg, version }: PackageVersion): string {
  return join(PACKAGES_DIR, org, pkg, version);
}

// ---------------------------------------------------------------------------
// Step 1: Discover new packages and lay down pending state
// ---------------------------------------------------------------------------

async function discoverNewPackages(): Promise<void> {
  const index = await countIndexedDocs();
  console.log(`[discover] Current index: ${index} docs.json files`);

  const url = `${BASE_URL}/all-packages/since/${index}`;
  console.log(`[discover] Fetching ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch package list: ${res.status} ${res.statusText}`);
  }

  const allPackages: string[] = await res.json();
  const packages = MAX_PACKAGES ? allPackages.slice(0, MAX_PACKAGES) : allPackages;
  console.log(`[discover] Found ${allPackages.length} new package version(s)${MAX_PACKAGES ? `, limited to first ${packages.length}` : ""}`);

  for (const raw of packages) {
    const pv = parsePackageString(raw);
    const dir = versionDir(pv);
    const docsPath = join(dir, "docs.json");
    const pendingPath = join(dir, "pending");

    // Skip if already successfully downloaded
    if (await fileExists(docsPath) && !(await fileExists(pendingPath))) {
      const content = await readFile(docsPath, "utf-8");
      if (content.length > 0) continue;
    }

    await mkdir(dir, { recursive: true });
    await writeFile(docsPath, "");
    await writeFile(pendingPath, "");
    console.log(`[discover] Queued ${pv.org}/${pv.pkg}@${pv.version}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Fetch all pending packages (parallel + throttled)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOne(pendingPath: string): Promise<boolean> {
  const dir = dirname(pendingPath);
  const rel = dir.slice(PACKAGES_DIR.length + 1); // "org/pkg/version"
  const [org, pkg, version] = rel.split("/");

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

    console.log(`[fetch] ✓ ${org}/${pkg}@${version}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(docsPath, "");
    await writeFile(errorsPath, JSON.stringify({ url, error: message }, null, 2));
    await rm(pendingPath);

    console.error(`[fetch] ✗ ${org}/${pkg}@${version}: ${message}`);
    return false;
  }
}

async function fetchPending(): Promise<void> {
  const pendingFiles: string[] = [];
  for await (const entry of glob(join(PACKAGES_DIR, "**/pending"))) {
    pendingFiles.push(entry);
  }

  const total = pendingFiles.length;
  console.log(`[fetch] ${total} pending package version(s) to download (concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms)`);

  let completed = 0;
  let failed = 0;

  async function worker(items: string[]) {
    for (const pendingPath of items) {
      const ok = await fetchOne(pendingPath);
      if (ok) completed++; else failed++;
      console.log(`[fetch] Progress: ${completed + failed}/${total} (${failed} errors)`);
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  // Split pending files into chunks, one per worker
  const chunks: string[][] = Array.from({ length: CONCURRENCY }, () => []);
  for (let i = 0; i < total; i++) {
    chunks[i % CONCURRENCY].push(pendingFiles[i]);
  }

  await Promise.all(chunks.map((chunk) => worker(chunk)));

  console.log(`[fetch] Completed: ${completed} succeeded, ${failed} failed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[sync] Starting package sync");
  await discoverNewPackages();
  await fetchPending();
  console.log("[sync] Done");
}

main();
