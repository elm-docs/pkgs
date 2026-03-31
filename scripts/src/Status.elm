module Status exposing (run)

{-| Show sync status of all known packages.

Fetches the full registry from `/all-packages/since/0`, classifies every
version against the local `content/` directory, and prints a summary with
counts and percentages for each state (success, pending, failure, missing).

-}

import BackendTask exposing (BackendTask)
import BackendTask.Glob as Glob
import BackendTask.Http
import FatalError exposing (FatalError)
import Json.Decode
import Pages.Script as Script exposing (Script)
import Set
import Shared.Ansi exposing (dim, red, yellow)
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
                    packages : List PackageVersion.PackageVersion
                    packages =
                        List.filterMap PackageVersion.fromString allPackageStrings
                in
                Script.log ("Classifying " ++ String.fromInt (List.length packages) ++ " packages…\n")
                    |> BackendTask.andThen (\() -> buildIndex)
                    |> BackendTask.map
                        (\index ->
                            let
                                classified : Classification.Classified
                                classified =
                                    Classification.classifyAll index packages

                                summary : Classification.Summary
                                summary =
                                    Classification.summarize classified
                            in
                            [ Report.formatSummary summary
                            , Report.formatDetailList "Pending packages" yellow classified.pending
                            , Report.formatDetailList "Packages with errors" red classified.failure
                            , Report.formatDetailList "Missing packages" dim classified.missing
                            ]
                                |> List.filter (not << String.isEmpty)
                                |> String.join "\n\n"
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
        segments : List String
        segments =
            String.split "/" path
    in
    case List.reverse segments of
        -- _filename :: version :: pkg :: org :: _rest
        _ :: ver :: p :: o :: _ ->
            o ++ "/" ++ p ++ "@" ++ ver

        _ ->
            path



