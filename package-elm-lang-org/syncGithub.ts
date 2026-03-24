import { readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGES_DIR, fileExists, packageDir } from "./lib/packages.ts";
import type { Package } from "./lib/packages.ts";
import { green, red, yellow, dim, writeLine } from "./lib/term.ts";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    concurrency: { type: "string", short: "c", default: "2" },
    delay: { type: "string", short: "d", default: "500" },
    update: { type: "boolean", default: false },
    token: { type: "string", short: "t" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: syncGithub.ts [options]

Options:
  -c, --concurrency <n>   Max parallel requests (default: 2)
  -d, --delay <ms>        Delay in ms between requests (default: 500)
      --update             Re-fetch even if github.json already exists
  -t, --token <token>     GitHub personal access token (default: GITHUB_TOKEN env var)
  -h, --help              Show this help message`);
  process.exit(0);
}

const CONCURRENCY = parseInt(flags.concurrency!, 10);
const DELAY_MS = parseInt(flags.delay!, 10);
const UPDATE = flags.update!;
const GITHUB_TOKEN = flags.token ?? process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("Error: GitHub token required. Set GITHUB_TOKEN env var or pass --token.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IssueInfo {
  number: number;
  created_at: string;
  last_comment_at: string | null;
  last_comment_by_maintainer: boolean | null;
}

interface DateStats {
  count: number;
  min_days: number;
  max_days: number;
  avg_days: number;
  items: IssueInfo[];
}

interface GithubInfo {
  fetched_at: string;
  stargazers_count: number;
  last_commit_at: string | null;
  open_issues: DateStats;
  open_prs: DateStats;
}

interface GithubRedirect {
  fetched_at: string;
  original_repo: string;
  redirected_to: string;
  new_org: string;
  new_name: string;
}

interface GithubMissing {
  fetched_at: string;
  repo: string;
  user_exists: boolean;
  user_type: string | null;
}

type GithubResult =
  | { kind: "info"; data: GithubInfo }
  | { kind: "redirect"; data: GithubRedirect }
  | { kind: "missing"; data: GithubMissing };

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type ErrorReason =
  | "rate_limit"
  | "not_found"
  | "moved"
  | "forbidden"
  | "network"
  | "unknown";

class GithubApiError extends Error {
  reason: ErrorReason;
  status: number | null;
  detail: string;

  constructor(reason: ErrorReason, status: number | null, detail: string) {
    super(detail);
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

function classifyResponse(status: number, body: { message?: string; documentation_url?: string }): GithubApiError {
  const msg = body.message ?? "";

  if (status === 403 || status === 429) {
    if (/rate limit/i.test(msg) || /API rate limit exceeded/i.test(msg)) {
      return new GithubApiError("rate_limit", status, `Rate limit exceeded: ${msg}`);
    }
    return new GithubApiError("forbidden", status, `Forbidden: ${msg}`);
  }

  if (status === 404) {
    return new GithubApiError("not_found", status, `Repository not found: ${msg}`);
  }

  if (status === 301) {
    return new GithubApiError("moved", status, `Repository moved: ${msg}`);
  }

  // GitHub returns 301 as a JSON body hint sometimes, but also signals moves via message
  if (/moved permanently/i.test(msg) || /repository.*changed/i.test(msg)) {
    return new GithubApiError("moved", status, `Repository moved: ${msg}`);
  }

  return new GithubApiError("unknown", status, `HTTP ${status}: ${msg}`);
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;

  let body: { message?: string; documentation_url?: string } = {};
  try {
    body = await res.json();
  } catch {
    // body wasn't JSON
  }
  throw classifyResponse(res.status, body);
}

// ---------------------------------------------------------------------------
// GitHub API helpers (with rate-limit awareness)
// ---------------------------------------------------------------------------

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Check rate-limit headers and pause if we're about to hit the wall.
 * GitHub returns:
 *   x-ratelimit-remaining: number of requests left in this window
 *   x-ratelimit-reset: unix timestamp when the window resets
 *   retry-after: seconds to wait (on 429/403 rate-limit responses)
 */
async function respectRateLimit(res: Response): Promise<void> {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAt = res.headers.get("x-ratelimit-reset");
  const retryAfter = res.headers.get("retry-after");

  // If we got a retry-after header, wait that long
  if (retryAfter) {
    const waitSec = parseInt(retryAfter, 10);
    if (waitSec > 0) {
      writeLine(`${dim("[rate-limit]")} ${yellow("⏳")} Retry-After: pausing ${waitSec}s`);
      await sleep(waitSec * 1000);
      return;
    }
  }

  // If remaining is low, proactively pause until the reset window
  if (remaining && resetAt) {
    const left = parseInt(remaining, 10);
    if (left <= 10) {
      const resetTime = parseInt(resetAt, 10) * 1000;
      const waitMs = Math.max(0, resetTime - Date.now()) + 1000; // +1s buffer
      const waitSec = Math.ceil(waitMs / 1000);
      writeLine(`${dim("[rate-limit]")} ${yellow("⏳")} ${left} requests left, pausing ${waitSec}s until reset`);
      await sleep(waitMs);
    }
  }
}

/** Core fetch wrapper: respects rate limits, returns raw Response. */
async function githubFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: githubHeaders() });
  await respectRateLimit(res);
  return res;
}

async function githubGet(path: string): Promise<Response> {
  return githubFetch(`${GITHUB_API}${path}`);
}

/** Fetch all pages of a paginated GitHub endpoint. */
async function githubGetAll<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = `${GITHUB_API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;

  while (url) {
    const res: Response = await githubFetch(url);
    await throwIfNotOk(res);
    const data: T[] = await res.json();
    results.push(...data);

    const link: string | null = res.headers.get("link");
    const next: RegExpMatchArray | null | undefined = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function daysSince(dateStr: string): number {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function computeDateStats(items: IssueInfo[]): DateStats {
  if (items.length === 0) {
    return { count: 0, min_days: 0, max_days: 0, avg_days: 0, items: [] };
  }

  const ages = items.map((i) => daysSince(i.created_at));
  const min = Math.min(...ages);
  const max = Math.max(...ages);
  const avg = Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);

  return { count: items.length, min_days: min, max_days: max, avg_days: avg, items };
}

async function fetchLastCommentInfo(
  org: string,
  pkg: string,
  issueNumber: number,
  maintainers: Set<string>,
): Promise<{ last_comment_at: string | null; last_comment_by_maintainer: boolean | null }> {
  const res = await githubGet(
    `/repos/${org}/${pkg}/issues/${issueNumber}/comments?per_page=1&sort=created&direction=desc`,
  );
  if (!res.ok) return { last_comment_at: null, last_comment_by_maintainer: null };

  const comments: Array<{ created_at: string; user?: { login: string } }> = await res.json();
  if (comments.length === 0) return { last_comment_at: null, last_comment_by_maintainer: null };

  const comment = comments[0];
  return {
    last_comment_at: comment.created_at,
    last_comment_by_maintainer: comment.user ? maintainers.has(comment.user.login) : null,
  };
}

async function fetchMaintainers(org: string, pkg: string): Promise<Set<string>> {
  const maintainers = new Set<string>();

  // Repo owner/collaborators with push+ access
  const res = await githubGet(`/repos/${org}/${pkg}/collaborators?affiliation=direct&per_page=100`);
  if (res.ok) {
    const collabs: Array<{
      login: string;
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
    }> = await res.json();
    for (const c of collabs) {
      if (c.permissions?.admin || c.permissions?.maintain || c.permissions?.push) {
        maintainers.add(c.login);
      }
    }
  }

  // If collaborators endpoint fails (common for repos you don't own), fall back to the repo owner
  if (maintainers.size === 0) {
    const repoRes = await githubGet(`/repos/${org}/${pkg}`);
    if (repoRes.ok) {
      const repo: { owner?: { login: string } } = await repoRes.json();
      if (repo.owner) maintainers.add(repo.owner.login);
    }
  }

  return maintainers;
}

async function fetchGithubInfo(pkg: Package): Promise<GithubResult> {
  const { org, pkg: name } = pkg;
  const originalRepo = `${org}/${name}`;

  // Fetch repo info — this is the critical call
  const repoRes = await githubGet(`/repos/${org}/${name}`);

  // Handle 404: check whether the user/org still exists
  if (repoRes.status === 404) {
    const userRes = await githubGet(`/users/${org}`);
    const userExists = userRes.ok;
    let userType: string | null = null;
    if (userExists) {
      const user: { type?: string } = await userRes.json();
      userType = user.type ?? null; // "User" or "Organization"
    }
    return {
      kind: "missing",
      data: {
        fetched_at: new Date().toISOString(),
        repo: originalRepo,
        user_exists: userExists,
        user_type: userType,
      },
    };
  }

  await throwIfNotOk(repoRes);
  const repo: { full_name: string; stargazers_count: number } = await repoRes.json();

  // Detect redirect: GitHub follows it transparently but the full_name will differ
  if (repo.full_name.toLowerCase() !== originalRepo.toLowerCase()) {
    const [newOrg, newName] = repo.full_name.split("/");
    return {
      kind: "redirect",
      data: {
        fetched_at: new Date().toISOString(),
        original_repo: originalRepo,
        redirected_to: repo.full_name,
        new_org: newOrg,
        new_name: newName,
      },
    };
  }

  // Fetch last commit date
  const commitsRes = await githubGet(`/repos/${org}/${name}/commits?per_page=1`);
  let lastCommitAt: string | null = null;
  if (commitsRes.ok) {
    const commits: Array<{ commit: { committer?: { date: string } } }> = await commitsRes.json();
    if (commits.length > 0) {
      lastCommitAt = commits[0].commit.committer?.date ?? null;
    }
  }

  // Fetch maintainers for comment attribution
  const maintainers = await fetchMaintainers(org, name);

  // Fetch all open issues and PRs (GitHub's issues API includes PRs)
  const allIssues = await githubGetAll<{
    number: number;
    created_at: string;
    pull_request?: unknown;
  }>(`/repos/${org}/${name}/issues?state=open`);

  const rawIssues = allIssues.filter((i) => !i.pull_request);
  const rawPrs = allIssues.filter((i) => i.pull_request);

  // Fetch last comment info for each issue/PR
  async function enrichItem(
    item: { number: number; created_at: string },
  ): Promise<IssueInfo> {
    const commentInfo = await fetchLastCommentInfo(org, name, item.number, maintainers);
    return {
      number: item.number,
      created_at: item.created_at,
      ...commentInfo,
    };
  }

  const issues = await Promise.all(rawIssues.map(enrichItem));
  const prs = await Promise.all(rawPrs.map(enrichItem));

  return {
    kind: "info",
    data: {
      fetched_at: new Date().toISOString(),
      stargazers_count: repo.stargazers_count,
      last_commit_at: lastCommitAt,
      open_issues: computeDateStats(issues),
      open_prs: computeDateStats(prs),
    },
  };
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

async function discoverPackages(): Promise<Package[]> {
  const packages: Package[] = [];

  const orgs = await readdir(PACKAGES_DIR);
  for (const org of orgs) {
    const orgPath = join(PACKAGES_DIR, org);
    const pkgs = await readdir(orgPath);
    for (const pkg of pkgs) {
      packages.push({ org, pkg });
    }
  }

  return packages;
}

async function shouldFetch(pkg: Package): Promise<boolean> {
  if (UPDATE) return true;

  const dir = packageDir(pkg);
  const [hasInfo, hasRedirect, hasMissing] = await Promise.all([
    fileExists(join(dir, "github.json")),
    fileExists(join(dir, "github-redirect.json")),
    fileExists(join(dir, "github-missing.json")),
  ]);
  return !hasInfo && !hasRedirect && !hasMissing;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPkg(pkg: Package): string {
  return `${pkg.org}/${pkg.pkg}`;
}

interface FetchResult {
  ok: boolean;
  pkg: Package;
  rateLimited?: boolean;
}

async function fetchOne(pkg: Package): Promise<FetchResult> {
  const dir = packageDir(pkg);
  const infoPath = join(dir, "github.json");
  const redirectPath = join(dir, "github-redirect.json");
  const missingPath = join(dir, "github-missing.json");
  const errorsPath = join(dir, "github-errors.json");

  async function attempt(): Promise<FetchResult> {
    const result = await fetchGithubInfo(pkg);

    // Write the appropriate result file
    const writePath =
      result.kind === "info" ? infoPath :
      result.kind === "redirect" ? redirectPath :
      missingPath;
    await writeFile(writePath, JSON.stringify(result.data, null, 2));

    // Clean up stale files from previous runs
    const staleFiles = [infoPath, redirectPath, missingPath, errorsPath].filter((p) => p !== writePath);
    for (const file of staleFiles) {
      if (await fileExists(file)) await rm(file);
    }

    return { ok: true, pkg };
  }

  try {
    return await attempt();
  } catch (err: unknown) {
    // On rate limit, wait 10x delay and retry once
    if (err instanceof GithubApiError && err.reason === "rate_limit") {
      const retryDelay = DELAY_MS * 2;
      writeLine(
        `${dim("[fetch]")} ${yellow("⏳")} ${formatPkg(pkg)} rate limited, retrying in ${retryDelay}ms`,
      );
      await sleep(retryDelay);

      try {
        return await attempt();
      } catch (retryErr: unknown) {
        // Retry also failed — fall through to error handling below
        return writeError(pkg, errorsPath, retryErr);
      }
    }

    return writeError(pkg, errorsPath, err);
  }
}

function writeError(pkg: Package, errorsPath: string, err: unknown): Promise<FetchResult> {
  const repo = `${pkg.org}/${pkg.pkg}`;

  let errorJson: Record<string, unknown>;
  if (err instanceof GithubApiError) {
    errorJson = {
      repo,
      reason: err.reason,
      status: err.status,
      error: err.detail,
      failed_at: new Date().toISOString(),
    };
  } else {
    const message = err instanceof Error ? err.message : String(err);
    errorJson = {
      repo,
      reason: "unknown" as ErrorReason,
      status: null,
      error: message,
      failed_at: new Date().toISOString(),
    };
  }

  return writeFile(errorsPath, JSON.stringify(errorJson, null, 2)).then(() => ({
    ok: false,
    pkg,
    rateLimited: err instanceof GithubApiError && err.reason === "rate_limit",
  }));
}

async function fetchAll(packages: Package[]): Promise<void> {
  const total = packages.length;
  console.log(
    `${dim("[fetch]")} ${total} package(s) to fetch (concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms)`,
  );

  if (total === 0) return;

  let completed = 0;
  let failed = 0;
  const failures: Package[] = [];

  async function worker(items: Package[]) {
    for (const pkg of items) {
      const result = await fetchOne(pkg);
      if (result.ok) {
        completed++;
        writeLine(`${dim("[fetch]")} ${green("✓")} ${formatPkg(result.pkg)}`);
      } else {
        failed++;
        failures.push(result.pkg);
        writeLine(`${dim("[fetch]")} ${red("✗")} ${formatPkg(result.pkg)}`);
      }
      const done = completed + failed;
      const pct = ((done / total) * 100).toFixed(1);
      writeLine(
        `${dim("[fetch]")} Progress: ${done}/${total} ${dim(`(${pct}%)`)} (${failed} errors)`,
      );
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  const chunks: Package[][] = Array.from({ length: CONCURRENCY }, () => []);
  for (let i = 0; i < total; i++) {
    chunks[i % CONCURRENCY].push(packages[i]);
  }

  await Promise.all(chunks.map((chunk) => worker(chunk)));

  console.log();
  console.log(
    `${dim("[fetch]")} Completed: ${green(String(completed))} succeeded, ${red(String(failed))} failed`,
  );

  if (failures.length > 0) {
    console.log();
    console.log(red("Packages with errors:"));
    const shown = failures.slice(0, 5);
    for (const p of shown) {
      console.log(`  ${dim("•")} ${formatPkg(p)}`);
    }
    if (failures.length > shown.length) {
      console.log(dim(`  … and ${failures.length - shown.length} more`));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`${dim("[syncGithub]")} Starting GitHub metadata sync`);
  if (UPDATE) console.log(`${dim("[syncGithub]")} --update: re-fetching all packages`);

  const allPackages = await discoverPackages();
  console.log(`${dim("[syncGithub]")} Found ${allPackages.length} package(s) on disk`);

  const toFetch: Package[] = [];
  for (const pkg of allPackages) {
    if (await shouldFetch(pkg)) {
      toFetch.push(pkg);
    }
  }
  console.log(`${dim("[syncGithub]")} ${toFetch.length} package(s) need GitHub info`);

  await fetchAll(toFetch);
  console.log(`${dim("[syncGithub]")} Done`);
}

main();
