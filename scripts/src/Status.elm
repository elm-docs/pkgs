module Status exposing (run)

{-| Show sync status by querying the SQLite database.

Reports counts of packages, versions, GitHub metadata, redirects,
missing repos, type-indexed packages, and sync completeness.

-}

import BackendTask exposing (BackendTask)
import BackendTask.Custom
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Json.Decode as Decode
import Json.Encode as Encode
import Pages.Script as Script exposing (Script)
import Shared.Ansi exposing (bold, dim, green, red, yellow)


type alias CliOptions =
    { db : String
    }


type alias DbStatus =
    { totalPackages : Int
    , totalVersions : Int
    , withGithub : Int
    , redirected : Int
    , missing : Int
    , typeIndexed : Int
    , pendingDocs : Int
    , erroredDocs : Int
    , githubErrors : Int
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            getDbStatus options.db
                |> BackendTask.andThen
                    (\status ->
                        Script.log (formatStatus status)
                    )
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "~/.elm-docs/elm-packages.db"
                    )
            )


formatStatus : DbStatus -> String
formatStatus status =
    let
        separator : String
        separator =
            String.repeat 40 "─"

        githubPct : String
        githubPct =
            formatPercent status.withGithub status.totalPackages

        typeIndexPct : String
        typeIndexPct =
            formatPercent status.typeIndexed status.totalPackages

        isComplete : Bool
        isComplete =
            status.pendingDocs == 0 && status.erroredDocs == 0

        completenessLine : String
        completenessLine =
            if isComplete then
                "  " ++ green "●" ++ " Complete:      " ++ bold "yes"

            else
                "  " ++ red "●" ++ " Complete:      " ++ bold "no" ++ " " ++ dim ("(" ++ String.fromInt (status.pendingDocs + status.erroredDocs) ++ " remaining)")

        syncLines : List String
        syncLines =
            if status.pendingDocs == 0 && status.erroredDocs == 0 && status.githubErrors == 0 then
                []

            else
                [ ""
                , bold "Sync Status"
                , separator
                ]
                    ++ (if status.pendingDocs > 0 then
                            [ "  " ++ yellow "◦" ++ " Pending docs:  " ++ bold (String.fromInt status.pendingDocs) ]

                        else
                            []
                       )
                    ++ (if status.erroredDocs > 0 then
                            [ "  " ++ red "✗" ++ " Errored docs:  " ++ bold (String.fromInt status.erroredDocs) ]

                        else
                            []
                       )
                    ++ (if status.githubErrors > 0 then
                            [ "  " ++ red "✗" ++ " GitHub errors: " ++ bold (String.fromInt status.githubErrors) ]

                        else
                            []
                       )
    in
    String.join "\n"
        ([ bold "Database Status"
         , separator
         , "  Packages:        " ++ bold (String.fromInt status.totalPackages)
         , "  Versions:        " ++ bold (String.fromInt status.totalVersions)
         , "  " ++ green "✓" ++ " With GitHub:   " ++ bold (String.fromInt status.withGithub) ++ " " ++ dim ("(" ++ githubPct ++ ")")
         , "  " ++ yellow "→" ++ " Redirected:    " ++ bold (String.fromInt status.redirected)
         , "  " ++ red "✗" ++ " Missing:       " ++ bold (String.fromInt status.missing)
         , "  " ++ dim "⊕" ++ " Type indexed:  " ++ bold (String.fromInt status.typeIndexed) ++ " " ++ dim ("(" ++ typeIndexPct ++ ")")
         , completenessLine
         ]
            ++ syncLines
        )


formatPercent : Int -> Int -> String
formatPercent part total =
    if total == 0 then
        "0.0%"

    else
        let
            scaled : Int
            scaled =
                (part * 1000) // total

            whole : Int
            whole =
                scaled // 10

            frac : Int
            frac =
                modBy 10 scaled
        in
        String.fromInt whole ++ "." ++ String.fromInt frac ++ "%"



-- FFI


getDbStatus : String -> BackendTask FatalError DbStatus
getDbStatus dbPath =
    BackendTask.Custom.run "getDbStatus"
        (Encode.object [ ( "dbPath", Encode.string dbPath ) ])
        (Decode.map6
            (\tp tv wg rd ms ti ->
                { totalPackages = tp
                , totalVersions = tv
                , withGithub = wg
                , redirected = rd
                , missing = ms
                , typeIndexed = ti
                , pendingDocs = 0
                , erroredDocs = 0
                , githubErrors = 0
                }
            )
            (Decode.field "totalPackages" Decode.int)
            (Decode.field "totalVersions" Decode.int)
            (Decode.field "withGithub" Decode.int)
            (Decode.field "redirected" Decode.int)
            (Decode.field "missing" Decode.int)
            (Decode.field "typeIndexed" Decode.int)
            |> Decode.andThen
                (\base ->
                    Decode.map3
                        (\pd ed ge ->
                            { base | pendingDocs = pd, erroredDocs = ed, githubErrors = ge }
                        )
                        (Decode.field "pendingDocs" Decode.int)
                        (Decode.field "erroredDocs" Decode.int)
                        (Decode.field "githubErrors" Decode.int)
                )
        )
        |> BackendTask.allowFatal
