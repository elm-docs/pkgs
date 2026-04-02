module SyncElmPackages exposing (run)

{-| Sync package documentation from package.elm-lang.org directly into SQLite.

**Discover** — queries the DB for a version count (high water mark), then
calls `/all-packages/since/{count}` to find newly published versions.

**Fetch** — downloads `docs.json` for each new version and upserts it into
the database via the `upsertDocs` FFI handler.

**Search metadata** — fetches `search.json` from the registry and upserts
package summaries and licenses.

**Type index** — builds the type index for any packages not yet indexed.

Flags: `--concurrency` (default 6), `--delay` (default 100ms), `--since`,
`--db` (default `~/.elm-docs/elm-packages.db`).

-}

import BackendTask exposing (BackendTask)
import BackendTask.Custom
import BackendTask.Http
import BuildDb.TypeIndex as TypeIndex
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Json.Decode as Decode
import Json.Encode as Encode
import Pages.Script as Script exposing (Script)
import Shared.Ansi exposing (dim, green, red)
import Shared.CliHelpers exposing (parseIntOpt)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)


type alias CliOptions =
    { concurrency : Int
    , delay : Int
    , since : Maybe Int
    , db : String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            initDb options.db
                |> BackendTask.andThen (\() -> Script.log (dim "[sync]" ++ " Starting package sync"))
                |> BackendTask.andThen (\() -> discoverAndFetch options)
                |> BackendTask.andThen (\() -> fetchSearchJson options.db)
                |> BackendTask.andThen (\() -> buildTypeIndex options.db)
                |> BackendTask.andThen (\() -> Script.log (dim "[sync]" ++ " Done"))
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with
                    (Option.optionalKeywordArg "concurrency"
                        |> Option.validateMap (parseIntOpt "concurrency" 6)
                    )
                |> with
                    (Option.optionalKeywordArg "delay"
                        |> Option.validateMap (parseIntOpt "delay" 100)
                    )
                |> with
                    (Option.optionalKeywordArg "since"
                        |> Option.validateMap parseSince
                    )
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "~/.elm-docs/elm-packages.db"
                    )
            )


parseSince : Maybe String -> Result String (Maybe Int)
parseSince maybeStr =
    case maybeStr of
        Nothing ->
            Ok Nothing

        Just str ->
            case String.toInt str of
                Just n ->
                    Ok (Just n)

                Nothing ->
                    Err ("Invalid since value: " ++ str)



-- Discovery & Fetch


discoverAndFetch : CliOptions -> BackendTask FatalError ()
discoverAndFetch options =
    resolveIndex options
        |> BackendTask.andThen
            (\index ->
                Script.log (dim "[discover]" ++ " Current index: " ++ String.fromInt index ++ indexLabel options.since)
                    |> BackendTask.andThen
                        (\() ->
                            let
                                url : String
                                url =
                                    "https://package.elm-lang.org/all-packages/since/" ++ String.fromInt index
                            in
                            Script.log (dim "[discover]" ++ " Fetching " ++ url)
                                |> BackendTask.andThen (\() -> fetchPackageList url)
                                |> BackendTask.andThen
                                    (\rawPackages ->
                                        let
                                            packages : List PackageVersion
                                            packages =
                                                List.filterMap PackageVersion.fromString rawPackages
                                        in
                                        Script.log (dim "[discover]" ++ " Found " ++ String.fromInt (List.length packages) ++ " new package version(s)")
                                            |> BackendTask.andThen (\() -> fetchAllDocs options packages)
                                    )
                        )
            )


indexLabel : Maybe Int -> String
indexLabel maybeSince =
    case maybeSince of
        Just _ ->
            " (manual)"

        Nothing ->
            " (from DB)"


resolveIndex : CliOptions -> BackendTask FatalError Int
resolveIndex options =
    case options.since of
        Just n ->
            BackendTask.succeed n

        Nothing ->
            getHighWaterMark options.db


fetchPackageList : String -> BackendTask FatalError (List String)
fetchPackageList url =
    BackendTask.Http.getJson url (Decode.list Decode.string)
        |> BackendTask.allowFatal



-- Fetch docs


type alias FetchProgress =
    { completed : Int
    , failed : Int
    , total : Int
    , failures : List PackageVersion
    }


fetchAllDocs : CliOptions -> List PackageVersion -> BackendTask FatalError ()
fetchAllDocs options packages =
    let
        total : Int
        total =
            List.length packages

        batches : List (List PackageVersion)
        batches =
            chunk options.concurrency packages
    in
    Script.log (dim "[fetch]" ++ " " ++ String.fromInt total ++ " package version(s) to download (concurrency: " ++ String.fromInt options.concurrency ++ ", delay: " ++ String.fromInt options.delay ++ "ms)")
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


processBatches : CliOptions -> List (List PackageVersion) -> FetchProgress -> BackendTask FatalError FetchProgress
processBatches options batches progress =
    case batches of
        [] ->
            BackendTask.succeed progress

        batch :: rest ->
            BackendTask.combine (List.map (fetchOnePackage options.db) batch)
                |> BackendTask.andThen
                    (\results ->
                        let
                            newProgress : FetchProgress
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

                            done : Int
                            done =
                                newProgress.completed + newProgress.failed

                            pct : String
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


fetchOnePackage : String -> PackageVersion -> BackendTask FatalError FetchResult
fetchOnePackage dbPath pv =
    let
        url : String
        url =
            "https://package.elm-lang.org/packages/"
                ++ PackageVersion.org pv
                ++ "/"
                ++ PackageVersion.pkg pv
                ++ "/"
                ++ PackageVersion.version pv
                ++ "/docs.json"
    in
    BackendTask.Http.get url BackendTask.Http.expectString
        |> BackendTask.allowFatal
        |> BackendTask.andThen
            (\body ->
                upsertDocs dbPath (PackageVersion.org pv) (PackageVersion.pkg pv) (PackageVersion.version pv) body
                    |> BackendTask.map (\_ -> { ok = True, pv = pv })
            )
        |> BackendTask.onError (\_ -> BackendTask.succeed { ok = False, pv = pv })



-- Search.json


fetchSearchJson : String -> BackendTask FatalError ()
fetchSearchJson dbPath =
    Script.log (dim "[search]" ++ " Fetching search.json")
        |> BackendTask.andThen
            (\() ->
                BackendTask.Http.get "https://package.elm-lang.org/search.json" BackendTask.Http.expectString
                    |> BackendTask.allowFatal
                    |> BackendTask.andThen
                        (\body ->
                            ingestSearchJsonBody dbPath body
                                |> BackendTask.andThen
                                    (\count ->
                                        Script.log (green ("  " ++ String.fromInt count ++ " packages from search.json"))
                                    )
                        )
                    |> BackendTask.onError
                        (\_ ->
                            Script.log (red "  Failed to fetch search.json (continuing)")
                        )
            )



-- Type Index


buildTypeIndex : String -> BackendTask FatalError ()
buildTypeIndex dbPath =
    Script.log "Building type index..."
        |> BackendTask.andThen (\() -> typeIndexLoop dbPath 0 0)
        |> BackendTask.andThen
            (\totalInserted ->
                Script.log (green ("  " ++ String.fromInt totalInserted ++ " type index entries"))
            )


typeIndexLoop : String -> Int -> Int -> BackendTask FatalError Int
typeIndexLoop dbPath parseErrors totalInserted =
    let
        pageSize : Int
        pageSize =
            500
    in
    getTypeEntriesToIndex dbPath 0 pageSize
        |> BackendTask.andThen
            (\result ->
                let
                    processedPackages : List TypeIndex.ProcessResult
                    processedPackages =
                        List.map
                            (\pkg -> TypeIndex.processEntries pkg.packageId pkg.versionId pkg.majorVersion pkg.isLatest pkg.entries)
                            result.packages

                    allRows : List TypeIndex.TypeIndexRow
                    allRows =
                        List.concatMap .rows processedPackages

                    batchParseErrors : Int
                    batchParseErrors =
                        List.foldl (\p acc -> acc + p.parseErrors) 0 processedPackages

                    deleteIds : List Int
                    deleteIds =
                        List.map .packageId result.packages
                in
                buildTypeIndexFfi dbPath allRows deleteIds
                    |> BackendTask.andThen
                        (\inserted ->
                            let
                                newTotal : Int
                                newTotal =
                                    totalInserted + inserted

                                newErrors : Int
                                newErrors =
                                    parseErrors + batchParseErrors
                            in
                            if result.hasMore then
                                typeIndexLoop dbPath newErrors newTotal

                            else if newErrors > 0 then
                                Script.log ("  (" ++ String.fromInt newErrors ++ " types skipped due to parse errors)")
                                    |> BackendTask.map (\() -> newTotal)

                            else
                                BackendTask.succeed newTotal
                        )
            )



-- FFI Calls


initDb : String -> BackendTask FatalError ()
initDb dbPath =
    BackendTask.Custom.run "initDb"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool False )
            ]
        )
        (Decode.succeed ())
        |> BackendTask.allowFatal


getHighWaterMark : String -> BackendTask FatalError Int
getHighWaterMark dbPath =
    BackendTask.Custom.run "getHighWaterMark"
        (Encode.object [ ( "dbPath", Encode.string dbPath ) ])
        (Decode.field "count" Decode.int)
        |> BackendTask.allowFatal


upsertDocs : String -> String -> String -> String -> String -> BackendTask FatalError Int
upsertDocs dbPath org name version docsJson =
    BackendTask.Custom.run "upsertDocs"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "org", Encode.string org )
            , ( "name", Encode.string name )
            , ( "version", Encode.string version )
            , ( "docsJson", Encode.string docsJson )
            ]
        )
        (Decode.field "modules" Decode.int)
        |> BackendTask.allowFatal


ingestSearchJsonBody : String -> String -> BackendTask FatalError Int
ingestSearchJsonBody dbPath body =
    BackendTask.Custom.run "ingestSearchJsonBody"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "body", Encode.string body )
            ]
        )
        (Decode.field "count" Decode.int)
        |> BackendTask.allowFatal


type alias TypeEntryPackage =
    { packageId : Int
    , versionId : Int
    , majorVersion : Int
    , isLatest : Bool
    , entries : List TypeIndex.TypeEntry
    }


getTypeEntriesToIndex : String -> Int -> Int -> BackendTask FatalError { packages : List TypeEntryPackage, hasMore : Bool }
getTypeEntriesToIndex dbPath offset limit =
    BackendTask.Custom.run "getTypeEntriesToIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool False )
            , ( "offset", Encode.int offset )
            , ( "limit", Encode.int limit )
            ]
        )
        (Decode.map2 (\pkgs more -> { packages = pkgs, hasMore = more })
            (Decode.field "packages" (Decode.list typeEntryPackageDecoder))
            (Decode.field "hasMore" Decode.bool)
        )
        |> BackendTask.allowFatal


typeEntryPackageDecoder : Decode.Decoder TypeEntryPackage
typeEntryPackageDecoder =
    Decode.map5 TypeEntryPackage
        (Decode.field "packageId" Decode.int)
        (Decode.field "versionId" Decode.int)
        (Decode.field "majorVersion" Decode.int)
        (Decode.field "isLatest" Decode.bool)
        (Decode.field "entries" (Decode.list typeEntryDecoder))


typeEntryDecoder : Decode.Decoder TypeIndex.TypeEntry
typeEntryDecoder =
    Decode.map4 TypeIndex.TypeEntry
        (Decode.field "moduleName" Decode.string)
        (Decode.field "name" Decode.string)
        (Decode.field "kind" Decode.string)
        (Decode.field "typeRaw" Decode.string)


buildTypeIndexFfi : String -> List TypeIndex.TypeIndexRow -> List Int -> BackendTask FatalError Int
buildTypeIndexFfi dbPath entries deletePackageIds =
    BackendTask.Custom.run "buildTypeIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool False )
            , ( "entries", Encode.list encodeTypeIndexRow entries )
            , ( "deletePackageIds", Encode.list Encode.int deletePackageIds )
            ]
        )
        (Decode.field "inserted" Decode.int)
        |> BackendTask.allowFatal


encodeTypeIndexRow : TypeIndex.TypeIndexRow -> Encode.Value
encodeTypeIndexRow row =
    Encode.object
        [ ( "packageId", Encode.int row.packageId )
        , ( "versionId", Encode.int row.versionId )
        , ( "moduleName", Encode.string row.moduleName )
        , ( "name", Encode.string row.name )
        , ( "kind", Encode.string row.kind )
        , ( "typeRaw", Encode.string row.typeRaw )
        , ( "typeAstJson", Encode.string row.typeAstJson )
        , ( "fingerprint", Encode.string row.fingerprint )
        , ( "argCount", Encode.int row.argCount )
        , ( "majorVersion", Encode.int row.majorVersion )
        , ( "isLatest", Encode.bool row.isLatest )
        ]



-- Helpers


formatFailures : List PackageVersion -> String
formatFailures failures =
    let
        header : String
        header =
            "\n" ++ red "Packages with errors:"

        items : List String
        items =
            List.take 5 failures
                |> List.map (\pv -> "  • " ++ PackageVersion.toLabel pv)

        remaining : Int
        remaining =
            List.length failures - 5
    in
    if remaining > 0 then
        String.join "\n" (header :: items ++ [ "  … and " ++ String.fromInt remaining ++ " more" ])

    else
        String.join "\n" (header :: items)


chunk : Int -> List a -> List (List a)
chunk size list =
    if size <= 0 || List.isEmpty list then
        []

    else
        List.take size list :: chunk size (List.drop size list)
