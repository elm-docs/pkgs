module ProjectContext.ProjectPath exposing (dbPath)

{-| Resolves the temporary database path for project-scoped searches.
-}

dbPath : String -> String -> String
dbPath homeDir hash =
    homeDir ++ "/.elm-docs/projects/" ++ hash ++ "/context.db"
