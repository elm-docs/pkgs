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
