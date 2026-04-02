# elm-docs

Offline CLI tool for searching Elm packages, functions, and types.

- **Text search** — find packages by name, author, or summary
- **Type search** — find functions by type signature
- **Project-scoped** — restrict results to your direct dependencies and local modules

```sh
elm-docs search 'json'
elm-docs type-search 'List a -> Maybe a'
elm-docs type-search 'String -> Int' --project
```

All data is synced locally and queried from a SQLite database. No network requests at search time.

## MCP Server

elm-docs includes an [MCP](https://modelcontextprotocol.io/) server that gives LLMs direct access to Elm package documentation. Instead of guessing at function names or type signatures, an LLM can look them up.

The server exposes five tools:

| Tool | Purpose |
|------|---------|
| `search_packages` | Find packages by keyword |
| `type_search` | Find functions by type signature |
| `get_package_docs` | Full documentation for a package |
| `get_module_docs` | Documentation for a single module |
| `lookup_value` | Look up a function or type by name |

All tools that return cross-package results accept an optional `project_path` parameter pointing to a directory with an `elm.json`, restricting results to direct dependencies and local project modules.

### Setup

Install elm-docs, then sync the database once:

```sh
npm install -g @elm-docs/cli
elm-docs sync
```

#### Claude Code

```sh
claude mcp add elm-docs -- elm-docs mcp
```

#### Claude Desktop

Add to your [Claude Desktop config](https://modelcontextprotocol.io/quickstart/user):

```json
{
  "mcpServers": {
    "elm-docs": {
      "command": "elm-docs",
      "args": ["mcp"]
    }
  }
}
```

#### Other MCP clients

Any client that supports stdio transport can run `elm-docs mcp`. Pass `--db <path>` to override the default database location (`~/.elm-docs/elm-packages.db`).
