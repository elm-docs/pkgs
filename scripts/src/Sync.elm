module Sync exposing (run)

import BackendTask exposing (BackendTask)
import BackendTask.Glob as Glob
import BackendTask.Http
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Json.Decode
import Pages.Script as Script exposing (Script)
import Set exposing (Set)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)
import Sync.Discovery as Discovery
import Sync.Fetch as Fetch exposing (WriteAction(..))
import Sync.Path as Path


type alias CliOptions =
    { concurrency : Int
    , delay : Int
    , since : Maybe Int
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            Script.log (dim "[sync]" ++ " Starting package sync")
                |> BackendTask.andThen (\() -> discoverNewPackages options)
                |> BackendTask.andThen (\() -> fetchPending options)
                |> BackendTask.andThen (\() -> Script.log (dim "[sync]" ++ " Done"))
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with
                    (Option.optionalKeywordArg "concurrency"
                        |> Option.validateMap
                            (\maybeStr ->
                                case maybeStr of
                                    Nothing ->
                                        Ok 6

                                    Just str ->
                                        case String.toInt str of
                                            Just n ->
                                                Ok n

                                            Nothing ->
                                                Err ("Invalid concurrency value: " ++ str)
                            )
                    )
                |> with
                    (Option.optionalKeywordArg "delay"
                        |> Option.validateMap
                            (\maybeStr ->
                                case maybeStr of
                                    Nothing ->
                                        Ok 100

                                    Just str ->
                                        case String.toInt str of
                                            Just n ->
                                                Ok n

                                            Nothing ->
                                                Err ("Invalid delay value: " ++ str)
                            )
                    )
                |> with
                    (Option.optionalKeywordArg "since"
                        |> Option.validateMap
                            (\maybeStr ->
                                case maybeStr of
                                    Nothing ->
                                        Ok Nothing

                                    Just str ->
                                        case String.toInt str of
                                            Just n ->
                                                Ok (Just n)

                                            Nothing ->
                                                Err ("Invalid since value: " ++ str)
                            )
                    )
            )



-- Discovery phase


discoverNewPackages : CliOptions -> BackendTask FatalError ()
discoverNewPackages options =
    resolveIndex options.since
        |> BackendTask.andThen
            (\index ->
                Script.log (dim "[discover]" ++ " Current index: " ++ String.fromInt index ++ indexLabel options.since)
                    |> BackendTask.andThen
                        (\() ->
                            let
                                url =
                                    "https://package.elm-lang.org/all-packages/since/" ++ String.fromInt index
                            in
                            Script.log (dim "[discover]" ++ " Fetching " ++ url)
                                |> BackendTask.andThen (\() -> fetchPackageList url)
                                |> BackendTask.andThen
                                    (\rawPackages ->
                                        Script.log (dim "[discover]" ++ " Found " ++ String.fromInt (List.length rawPackages) ++ " new package version(s)")
                                            |> BackendTask.andThen (\() -> buildExistingKeys)
                                            |> BackendTask.andThen
                                                (\existingKeys ->
                                                    let
                                                        newPackages =
                                                            Discovery.filterNew existingKeys rawPackages
                                                    in
                                                    queuePackages newPackages
                                                        |> BackendTask.andThen
                                                            (\queued ->
                                                                if queued > 0 then
                                                                    Script.log (dim "[discover]" ++ " Queued " ++ String.fromInt queued ++ " package(s)")

                                                                else
                                                                    BackendTask.succeed ()
                                                            )
                                                )
                                    )
                        )
            )


indexLabel : Maybe Int -> String
indexLabel maybeSince =
    case maybeSince of
        Just _ ->
            " (manual)"

        Nothing ->
            " docs.json files"


resolveIndex : Maybe Int -> BackendTask FatalError Int
resolveIndex maybeSince =
    case maybeSince of
        Just n ->
            BackendTask.succeed n

        Nothing ->
            Glob.fromString (Path.contentDir ++ "/*/*/*/docs.json")
                |> BackendTask.map List.length


fetchPackageList : String -> BackendTask FatalError (List String)
fetchPackageList url =
    BackendTask.Http.getJson url (Json.Decode.list Json.Decode.string)
        |> BackendTask.allowFatal


buildExistingKeys : BackendTask FatalError (Set String)
buildExistingKeys =
    Glob.fromString (Path.contentDir ++ "/*/*/*/docs.json")
        |> BackendTask.map (\paths -> Set.fromList (List.map extractKey paths))


queuePackages : List PackageVersion -> BackendTask FatalError Int
queuePackages packages =
    List.foldl
        (\pv task ->
            task
                |> BackendTask.andThen
                    (\count ->
                        let
                            dir =
                                Path.toVersionDir pv
                        in
                        Script.makeDirectory { recursive = True } dir
                            |> BackendTask.andThen
                                (\() ->
                                    Script.writeFile { path = Path.toDocsPath pv, body = "" }
                                        |> BackendTask.allowFatal
                                )
                            |> BackendTask.andThen
                                (\() ->
                                    Script.writeFile { path = Path.toPendingPath pv, body = "" }
                                        |> BackendTask.allowFatal
                                )
                            |> BackendTask.andThen
                                (\() ->
                                    Script.log (dim "[discover]" ++ " Queued " ++ PackageVersion.toLabel pv)
                                        |> BackendTask.map (\() -> count + 1)
                                )
                    )
        )
        (BackendTask.succeed 0)
        packages



-- Fetch phase


fetchPending : CliOptions -> BackendTask FatalError ()
fetchPending options =
    Glob.fromString (Path.contentDir ++ "/*/*/*/pending")
        |> BackendTask.andThen
            (\pendingPaths ->
                let
                    total =
                        List.length pendingPaths

                    packages =
                        List.filterMap parsePendingPath pendingPaths

                    batches =
                        chunk options.concurrency packages
                in
                Script.log (dim "[fetch]" ++ " " ++ String.fromInt total ++ " pending package version(s) to download (concurrency: " ++ String.fromInt options.concurrency ++ ", delay: " ++ String.fromInt options.delay ++ "ms)")
                    |> BackendTask.andThen (\() -> processBatches options batches { completed = 0, failed = 0, total = total, failures = [] })
                    |> BackendTask.andThen
                        (\result ->
                            Script.log (dim "[fetch]" ++ " Completed: " ++ green (String.fromInt result.completed) ++ " succeeded, " ++ red (String.fromInt result.failed) ++ " failed")
                                |> BackendTask.andThen
                                    (\() ->
                                        if List.isEmpty result.failures then
                                            BackendTask.succeed ()

                                        else
                                            Script.log (formatFailures result.failures)
                                    )
                        )
            )


type alias FetchProgress =
    { completed : Int
    , failed : Int
    , total : Int
    , failures : List PackageVersion
    }


processBatches : CliOptions -> List (List PackageVersion) -> FetchProgress -> BackendTask FatalError FetchProgress
processBatches options batches progress =
    case batches of
        [] ->
            BackendTask.succeed progress

        batch :: rest ->
            let
                fetchTasks =
                    List.map fetchOnePackage batch
            in
            BackendTask.combine fetchTasks
                |> BackendTask.andThen
                    (\results ->
                        let
                            newProgress =
                                List.foldl
                                    (\result acc ->
                                        if result.ok then
                                            { acc | completed = acc.completed + 1 }

                                        else
                                            { acc | failed = acc.failed + 1, failures = result.pv :: acc.failures }
                                    )
                                    progress
                                    results

                            done =
                                newProgress.completed + newProgress.failed

                            pct =
                                if newProgress.total > 0 then
                                    String.fromInt (done * 100 // newProgress.total)

                                else
                                    "0"
                        in
                        Script.log (dim "[fetch]" ++ " Progress: " ++ String.fromInt done ++ "/" ++ String.fromInt newProgress.total ++ dim (" (" ++ pct ++ "%)") ++ " (" ++ String.fromInt newProgress.failed ++ " errors)")
                            |> BackendTask.andThen
                                (\() ->
                                    if options.delay > 0 && not (List.isEmpty rest) then
                                        Script.sleep options.delay
                                            |> BackendTask.andThen (\() -> processBatches options rest newProgress)

                                    else
                                        processBatches options rest newProgress
                                )
                    )


type alias FetchResult =
    { ok : Bool
    , pv : PackageVersion
    }


fetchOnePackage : PackageVersion -> BackendTask FatalError FetchResult
fetchOnePackage pv =
    let
        url =
            Path.toDocsUrl pv

        docsPath =
            Path.toDocsPath pv

        errorsPath =
            Path.toErrorsPath pv

        pendingPath =
            Path.toPendingPath pv

        paths =
            { docsPath = docsPath, pendingPath = pendingPath, errorsPath = errorsPath }
    in
    BackendTask.Http.get url BackendTask.Http.expectString
        |> BackendTask.map (\body -> Fetch.onSuccess { docsPath = paths.docsPath, pendingPath = paths.pendingPath, errorsPath = paths.errorsPath, body = body })
        |> BackendTask.onError
            (\{ recoverable } ->
                let
                    errorMessage =
                        case recoverable of
                            BackendTask.Http.BadUrl badUrl ->
                                "BadUrl: " ++ badUrl

                            BackendTask.Http.Timeout ->
                                "Timeout"

                            BackendTask.Http.NetworkError ->
                                "Network Error"

                            BackendTask.Http.BadStatus metadata _ ->
                                "HTTP " ++ String.fromInt metadata.statusCode ++ " " ++ metadata.statusText

                            BackendTask.Http.BadBody _ msg ->
                                "Bad Body: " ++ msg
                in
                BackendTask.succeed
                    (Fetch.onFailure { docsPath = paths.docsPath, pendingPath = paths.pendingPath, errorsPath = paths.errorsPath, url = url, error = errorMessage })
            )
        |> BackendTask.andThen
            (\actions ->
                executeActions actions
                    |> BackendTask.map (\() -> { ok = isSuccessActions actions, pv = pv })
            )


isSuccessActions : List WriteAction -> Bool
isSuccessActions actions =
    case actions of
        (WriteFile { body }) :: _ ->
            body /= ""

        _ ->
            False


executeActions : List WriteAction -> BackendTask FatalError ()
executeActions actions =
    actions
        |> List.map
            (\action ->
                case action of
                    WriteFile { path, body } ->
                        Script.writeFile { path = path, body = body }
                            |> BackendTask.allowFatal

                    DeleteFile path ->
                        Script.removeFile path
            )
        |> BackendTask.doEach


formatFailures : List PackageVersion -> String
formatFailures failures =
    let
        header =
            "\n" ++ red "Packages with errors:"

        items =
            List.take 5 failures
                |> List.map (\pv -> "  • " ++ PackageVersion.toLabel pv)

        remaining =
            List.length failures - 5
    in
    if remaining > 0 then
        String.join "\n" (header :: items ++ [ "  … and " ++ String.fromInt remaining ++ " more" ])

    else
        String.join "\n" (header :: items)



-- Helpers


parsePendingPath : String -> Maybe PackageVersion
parsePendingPath path =
    PackageVersion.fromString (extractKey path)


extractKey : String -> String
extractKey path =
    case List.reverse (String.split "/" path) of
        _ :: ver :: p :: o :: _ ->
            o ++ "/" ++ p ++ "@" ++ ver

        _ ->
            path


chunk : Int -> List a -> List (List a)
chunk size list =
    if size <= 0 || List.isEmpty list then
        []

    else
        List.take size list :: chunk size (List.drop size list)



-- ANSI helpers


dim : String -> String
dim s =
    "\u{001B}[2m" ++ s ++ "\u{001B}[0m"


green : String -> String
green s =
    "\u{001B}[32m" ++ s ++ "\u{001B}[0m"


red : String -> String
red s =
    "\u{001B}[31m" ++ s ++ "\u{001B}[0m"
