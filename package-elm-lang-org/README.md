# package-elm-lang-org

Tools for syncing and inspecting package documentation from https://package.elm-lang.org.

## Content directory

Both scripts operate on the `content/packages/` directory. Each package version lives at:

```
content/packages/{org}/{package}/{version}/
```

A version directory can be in one of four states:

**Success** — `docs.json` contains the full documentation:
```
docs.json
```

**Failure** — `docs.json` is empty and `errors.json` has details:
```
docs.json
errors.json
```

**Pending** — `docs.json` is empty and a `pending` marker is present:
```
docs.json
pending
```

**Missing** — no directory exists for that version yet.

## Scripts

### `sync`

Syncs package documentation into `content/`. Runs in two phases:

**1. Discover** — counts existing `docs.json` files to determine an index, then calls `/all-packages/since/{index}` to get newly published versions. For each new version it creates a directory with an empty `docs.json` and a `pending` marker.

**2. Fetch** — finds all directories with a `pending` file and downloads docs in parallel. On success, `docs.json` is written and `pending` is removed. On failure, `pending` is removed and `errors.json` is written.

Re-running the script picks up any previously failed or incomplete downloads automatically.

#### Usage

```sh
# Sync all packages with defaults (6 workers, 100ms delay)
npm run sync

# Pass flags after --
npm run sync -- --concurrency=4 --delay=200
npm run sync -- --since=0
```

#### Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--concurrency` | `-c` | `6` | Number of parallel download workers |
| `--delay` | `-d` | `100` | Delay in ms between downloads per worker |
| `--since` | `-s` | auto | Use this index instead of counting local `docs.json` files |
| `--help` | `-h` | | Show help message |

### `sync-github`

Fetches GitHub metadata for each package (not per version). Makes API calls to determine repository health and activity, then writes one result file at the package root:

```
content/packages/{org}/{package}/
  github.json            # successful fetch
  github-redirect.json   # repo was renamed/moved
  github-missing.json    # repo or user no longer exists (404)
  github-errors.json     # transient error (rate limit, network, etc.)
```

Only one of these files will exist per package. On each run the script:

1. Skips packages that already have `github.json`, `github-redirect.json`, or `github-missing.json`.
2. Retries packages that only have `github-errors.json` (transient failures).
3. Cleans up stale files when a package's status changes (e.g. a previously missing repo reappears on `--update`).

#### Data collected

**`github.json`** — full metadata:
- `stargazers_count`
- `last_commit_at`
- `open_issues` / `open_prs` — each with `count`, `min_days`, `max_days`, `avg_days`, and per-item details (`number`, `created_at`, `last_comment_at`, `last_comment_by_maintainer`)

**`github-redirect.json`** — the repo was renamed or the user changed their handle:
- `original_repo`, `redirected_to`, `new_org`, `new_name`

**`github-missing.json`** — the repo returned 404:
- `repo`, `user_exists`, `user_type` (`"User"`, `"Organization"`, or `null`)

**`github-errors.json`** — a retryable error occurred:
- `repo`, `reason` (`rate_limit`, `forbidden`, `network`, `unknown`), `status`, `error`

#### Rate limiting

The script reads GitHub's `x-ratelimit-remaining` and `retry-after` headers on every response. When remaining requests drop to ≤ 10 it pauses until the rate-limit window resets. On a rate-limit error it retries once after a 2× delay before recording the failure.

#### Usage

```sh
# Fetch metadata for packages missing github info
npm run sync-github

# Re-fetch all packages (ignore existing results)
npm run sync-github -- --update

# Custom concurrency and delay
npm run sync-github -- --concurrency=1 --delay=1000
```

Requires a GitHub token via `GITHUB_TOKEN` env var or `--token`.

#### Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--concurrency` | `-c` | `2` | Number of parallel workers |
| `--delay` | `-d` | `500` | Delay in ms between requests per worker |
| `--update` | | `false` | Re-fetch even if a result file already exists |
| `--token` | `-t` | `GITHUB_TOKEN` | GitHub personal access token |
| `--help` | `-h` | | Show help message |

### `status`

Shows the sync status of all known packages. Fetches the full registry from `/all-packages/since/0`, classifies every version against the local `content/` directory, and prints a summary with counts and percentages for each state (success, pending, failure, missing).

#### Usage

```sh
npm run status
```
