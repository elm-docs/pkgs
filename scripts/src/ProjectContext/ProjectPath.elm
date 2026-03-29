module ProjectContext.ProjectPath exposing (dbPath)


dbPath : String -> String -> String
dbPath homeDir hash =
    homeDir ++ "/.elm-docs/projects/" ++ hash ++ "/context.db"
