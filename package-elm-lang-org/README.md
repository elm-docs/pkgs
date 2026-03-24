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

### `status`

Shows the sync status of all known packages. Fetches the full registry from `/all-packages/since/0`, classifies every version against the local `content/` directory, and prints a summary with counts and percentages for each state (success, pending, failure, missing).

#### Usage

```sh
npm run status
```
