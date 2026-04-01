module Status exposing (run)

{-| Show sync status by querying the SQLite database.

Reports counts of packages, versions, GitHub metadata, redirects,
missing repos, and type-indexed packages.

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
    in
    String.join "\n"
        [ bold "Database Status"
        , separator
        , "  Packages:        " ++ bold (String.fromInt status.totalPackages)
        , "  Versions:        " ++ bold (String.fromInt status.totalVersions)
        , "  " ++ green "✓" ++ " With GitHub:   " ++ bold (String.fromInt status.withGithub) ++ " " ++ dim ("(" ++ githubPct ++ ")")
        , "  " ++ yellow "→" ++ " Redirected:    " ++ bold (String.fromInt status.redirected)
        , "  " ++ red "✗" ++ " Missing:       " ++ bold (String.fromInt status.missing)
        , "  " ++ dim "⊕" ++ " Type indexed:  " ++ bold (String.fromInt status.typeIndexed) ++ " " ++ dim ("(" ++ typeIndexPct ++ ")")
        ]


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
        (Decode.map6 DbStatus
            (Decode.field "totalPackages" Decode.int)
            (Decode.field "totalVersions" Decode.int)
            (Decode.field "withGithub" Decode.int)
            (Decode.field "redirected" Decode.int)
            (Decode.field "missing" Decode.int)
            (Decode.field "typeIndexed" Decode.int)
        )
        |> BackendTask.allowFatal
