# package-elm-lang-org

Syncs package documentation from https://package.elm-lang.org into the local `content/` directory.

## How it works

The `sync.ts` script runs in two phases:

### 1. Discover

Counts existing `docs.json` files under `content/packages/` to determine an index, then calls the `/all-packages/since/{index}` endpoint to get newly published package versions. For each new version it creates a directory with an empty `docs.json` and a `pending` marker file:

```
content/packages/{org}/{package}/{version}/
  docs.json   (empty while pending)
  pending     (empty marker)
```

### 2. Fetch

Finds all directories with a `pending` file and downloads the docs in parallel. After each download, the state becomes one of:

**Success** -- `docs.json` is written with the full content and `pending` is removed:
```
content/packages/{org}/{package}/{version}/
  docs.json
```

**Failure** -- `docs.json` is left empty, `pending` is removed, and `errors.json` is written with details:
```
content/packages/{org}/{package}/{version}/
  docs.json
  errors.json
```

Re-running the script will pick up any previously failed or incomplete downloads automatically.

## Usage

The script is registered as an npm script. Use `--` to forward flags:

```sh
# Sync all packages with defaults (6 workers, 100ms delay)
npm run sync

# Pass flags after --
npm run sync -- --max-packages=10
npm run sync -- --concurrency=4 --delay=200
npm run sync -- -c 4 -d 200 -m 50
```

### Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--concurrency` | `-c` | `6` | Number of parallel download workers |
| `--delay` | `-d` | `100` | Delay in ms between downloads per worker |
| `--max-packages` | `-m` | all | Only process the first *n* packages from the API |
| `--help` | `-h` | | Show help message |
