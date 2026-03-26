module Status exposing (run)

import BackendTask exposing (BackendTask)
import BackendTask.Glob as Glob
import BackendTask.Http
import FatalError exposing (FatalError)
import Json.Decode
import Pages.Script as Script exposing (Script)
import Set
import Shared.PackageVersion as PackageVersion
import Shared.Report as Report
import Status.Classification as Classification


run : Script
run =
    Script.withoutCliOptions
        (Script.log "Fetching all packages from registry…"
            |> BackendTask.andThen (\() -> fetchAndReport)
        )


fetchAndReport : BackendTask FatalError ()
fetchAndReport =
    fetchPackages
        |> BackendTask.andThen
            (\allPackageStrings ->
                let
                    packages =
                        List.filterMap PackageVersion.fromString allPackageStrings
                in
                Script.log ("Classifying " ++ String.fromInt (List.length packages) ++ " packages…\n")
                    |> BackendTask.andThen (\() -> buildIndex)
                    |> BackendTask.map
                        (\index ->
                            let
                                classified =
                                    Classification.classifyAll index packages

                                summary =
                                    Classification.summarize classified

                                output =
                                    [ Report.formatSummary summary
                                    , Report.formatDetailList "Pending packages" yellow classified.pending
                                    , Report.formatDetailList "Packages with errors" red classified.failure
                                    , Report.formatDetailList "Missing packages" dim classified.missing
                                    ]
                                        |> List.filter (not << String.isEmpty)
                                        |> String.join "\n\n"
                            in
                            output
                        )
                    |> BackendTask.andThen Script.log
            )


fetchPackages : BackendTask FatalError (List String)
fetchPackages =
    BackendTask.Http.getJson
        "https://package.elm-lang.org/all-packages/since/0"
        (Json.Decode.list Json.Decode.string)
        |> BackendTask.allowFatal


buildIndex : BackendTask FatalError Classification.FileIndex
buildIndex =
    BackendTask.map3
        (\docs errors pending ->
            { docsFiles = Set.fromList (List.map extractKey docs)
            , errorsFiles = Set.fromList (List.map extractKey errors)
            , pendingFiles = Set.fromList (List.map extractKey pending)
            }
        )
        (Glob.fromString "../package-elm-lang-org/content/packages/*/*/*/docs.json")
        (Glob.fromString "../package-elm-lang-org/content/packages/*/*/*/errors.json")
        (Glob.fromString "../package-elm-lang-org/content/packages/*/*/*/pending")


extractKey : String -> String
extractKey path =
    let
        segments =
            String.split "/" path
    in
    case List.reverse segments of
        -- _filename :: version :: pkg :: org :: _rest
        _ :: ver :: p :: o :: _ ->
            o ++ "/" ++ p ++ "@" ++ ver

        _ ->
            path



-- ANSI helpers (matching term.ts)


yellow : String -> String
yellow s =
    "\u{001B}[33m" ++ s ++ "\u{001B}[0m"


red : String -> String
red s =
    "\u{001B}[31m" ++ s ++ "\u{001B}[0m"


dim : String -> String
dim s =
    "\u{001B}[2m" ++ s ++ "\u{001B}[0m"
