module BuildDb exposing (run)

import BackendTask exposing (BackendTask)
import BackendTask.Custom
import BuildDb.TypeIndex as TypeIndex
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Json.Decode as Decode
import Json.Encode as Encode
import Pages.Script as Script exposing (Script)


type alias CliOptions =
    { full : Bool
    , db : String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            let
                contentDir : String
                contentDir =
                    "../package-elm-lang-org/content"

                searchJsonPath : String
                searchJsonPath =
                    contentDir ++ "/search.json"
            in
            -- 1. Init DB
            Script.log (modeLabel options.full)
                |> BackendTask.andThen (\() -> initDb options.db options.full)
                -- 2. Ingest search.json
                |> BackendTask.andThen
                    (\() ->
                        ingestSearchJson options.db searchJsonPath
                            |> BackendTask.andThen
                                (\count ->
                                    Script.log (green ("  " ++ String.fromInt count ++ " packages from search.json"))
                                )
                    )
                -- 3. Docs files
                |> BackendTask.andThen
                    (\() ->
                        findChangedFiles options.db contentDir "packages/**/docs.json"
                            |> BackendTask.andThen
                                (\files ->
                                    Script.log (dim ("  " ++ String.fromInt (List.length files) ++ " new/changed docs.json files"))
                                        |> BackendTask.andThen
                                            (\() ->
                                                if List.isEmpty files then
                                                    BackendTask.succeed ()

                                                else
                                                    ingestDocsJsonBatch options.db files
                                                        |> BackendTask.andThen
                                                            (\stats ->
                                                                Script.log
                                                                    (green
                                                                        ("  "
                                                                            ++ String.fromInt stats.ingested
                                                                            ++ " versions ingested ("
                                                                            ++ String.fromInt stats.modules
                                                                            ++ " modules)"
                                                                        )
                                                                    )
                                                            )
                                            )
                                )
                    )
                -- 4. Github files
                |> BackendTask.andThen
                    (\() ->
                        findChangedFiles options.db contentDir "packages/**/github*.json"
                            |> BackendTask.andThen
                                (\files ->
                                    Script.log (dim ("  " ++ String.fromInt (List.length files) ++ " new/changed github files"))
                                        |> BackendTask.andThen
                                            (\() ->
                                                if List.isEmpty files then
                                                    BackendTask.succeed ()

                                                else
                                                    ingestGithubBatch options.db files
                                                        |> BackendTask.andThen
                                                            (\stats ->
                                                                Script.log (green ("  " ++ String.fromInt stats.ingested ++ " github files ingested"))
                                                            )
                                            )
                                )
                    )
                -- 5. Rebuild search index
                |> BackendTask.andThen
                    (\() ->
                        rebuildSearchIndex options.db options.full
                            |> BackendTask.andThen
                                (\count ->
                                    Script.log (green ("  " ++ String.fromInt count ++ " search index entries"))
                                )
                    )
                -- 6. Type index
                |> BackendTask.andThen
                    (\() ->
                        Script.log "Building type index..."
                            |> BackendTask.andThen
                                (\() -> typeIndexLoop options.db options.full 0 0 0)
                            |> BackendTask.andThen
                                (\totalInserted ->
                                    Script.log (green ("  " ++ String.fromInt totalInserted ++ " type index entries"))
                                )
                    )
                -- 7. Done
                |> BackendTask.andThen (\() -> Script.log (green "\nDone."))
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with (Option.flag "full")
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "../db/elm-packages.db"
                    )
            )



-- FFI CALLS


initDb : String -> Bool -> BackendTask FatalError ()
initDb dbPath full =
    BackendTask.Custom.run "initDb"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool full )
            ]
        )
        (Decode.succeed ())
        |> BackendTask.allowFatal


ingestSearchJson : String -> String -> BackendTask FatalError Int
ingestSearchJson dbPath searchJsonPath =
    BackendTask.Custom.run "ingestSearchJson"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "searchJsonPath", Encode.string searchJsonPath )
            ]
        )
        (Decode.field "count" Decode.int)
        |> BackendTask.allowFatal


type alias FileRef =
    { relative : String
    , absolute : String
    , mtimeMs : Int
    , size : Int
    }


findChangedFiles : String -> String -> String -> BackendTask FatalError (List FileRef)
findChangedFiles dbPath contentDir glob =
    BackendTask.Custom.run "findChangedFiles"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "contentDir", Encode.string contentDir )
            , ( "glob", Encode.string glob )
            ]
        )
        (Decode.list fileRefDecoder)
        |> BackendTask.allowFatal


fileRefDecoder : Decode.Decoder FileRef
fileRefDecoder =
    Decode.map4 FileRef
        (Decode.field "relative" Decode.string)
        (Decode.field "absolute" Decode.string)
        (Decode.field "mtimeMs" Decode.int)
        (Decode.field "size" Decode.int)


encodeFileRef : FileRef -> Encode.Value
encodeFileRef f =
    Encode.object
        [ ( "relative", Encode.string f.relative )
        , ( "absolute", Encode.string f.absolute )
        , ( "mtimeMs", Encode.int f.mtimeMs )
        , ( "size", Encode.int f.size )
        ]


ingestDocsJsonBatch : String -> List FileRef -> BackendTask FatalError { ingested : Int, modules : Int }
ingestDocsJsonBatch dbPath files =
    BackendTask.Custom.run "ingestDocsJsonBatch"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "files", Encode.list encodeFileRef files )
            ]
        )
        (Decode.map2 (\i m -> { ingested = i, modules = m })
            (Decode.field "ingested" Decode.int)
            (Decode.field "modules" Decode.int)
        )
        |> BackendTask.allowFatal


ingestGithubBatch : String -> List FileRef -> BackendTask FatalError { ingested : Int }
ingestGithubBatch dbPath files =
    BackendTask.Custom.run "ingestGithubBatch"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "files", Encode.list encodeFileRef files )
            ]
        )
        (Decode.map (\i -> { ingested = i })
            (Decode.field "ingested" Decode.int)
        )
        |> BackendTask.allowFatal


rebuildSearchIndex : String -> Bool -> BackendTask FatalError Int
rebuildSearchIndex dbPath full =
    BackendTask.Custom.run "rebuildSearchIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool full )
            ]
        )
        (Decode.field "count" Decode.int)
        |> BackendTask.allowFatal


type alias TypeEntryPackage =
    { packageId : Int
    , versionId : Int
    , entries : List TypeIndex.TypeEntry
    }


getTypeEntriesToIndex : String -> Bool -> Int -> Int -> BackendTask FatalError { packages : List TypeEntryPackage, hasMore : Bool }
getTypeEntriesToIndex dbPath full offset limit =
    BackendTask.Custom.run "getTypeEntriesToIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool full )
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
    Decode.map3 TypeEntryPackage
        (Decode.field "packageId" Decode.int)
        (Decode.field "versionId" Decode.int)
        (Decode.field "entries" (Decode.list typeEntryDecoder))


typeEntryDecoder : Decode.Decoder TypeIndex.TypeEntry
typeEntryDecoder =
    Decode.map4 TypeIndex.TypeEntry
        (Decode.field "moduleName" Decode.string)
        (Decode.field "name" Decode.string)
        (Decode.field "kind" Decode.string)
        (Decode.field "typeRaw" Decode.string)


buildTypeIndexFfi : String -> Bool -> List TypeIndex.TypeIndexRow -> List Int -> BackendTask FatalError Int
buildTypeIndexFfi dbPath full entries deletePackageIds =
    BackendTask.Custom.run "buildTypeIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool full )
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
        ]



-- TYPE INDEX LOOP


typeIndexLoop : String -> Bool -> Int -> Int -> Int -> BackendTask FatalError Int
typeIndexLoop dbPath full offset parseErrors totalInserted =
    let
        pageSize : Int
        pageSize =
            50
    in
    getTypeEntriesToIndex dbPath full offset pageSize
        |> BackendTask.andThen
            (\result ->
                let
                    allRows : List TypeIndex.TypeIndexRow
                    allRows =
                        List.concatMap
                            (\pkg ->
                                let
                                    processed : TypeIndex.ProcessResult
                                    processed =
                                        TypeIndex.processEntries pkg.packageId pkg.versionId pkg.entries
                                in
                                processed.rows
                            )
                            result.packages

                    batchParseErrors : Int
                    batchParseErrors =
                        List.foldl
                            (\pkg acc ->
                                acc + (TypeIndex.processEntries pkg.packageId pkg.versionId pkg.entries).parseErrors
                            )
                            0
                            result.packages

                    deleteIds : List Int
                    deleteIds =
                        List.map .packageId result.packages
                in
                buildTypeIndexFfi dbPath full allRows deleteIds
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
                                typeIndexLoop dbPath full (offset + pageSize) newErrors newTotal

                            else if newErrors > 0 then
                                Script.log ("  (" ++ String.fromInt newErrors ++ " types skipped due to parse errors)")
                                    |> BackendTask.map (\() -> newTotal)

                            else
                                BackendTask.succeed newTotal
                        )
            )



-- ANSI helpers


green : String -> String
green s =
    "\u{001B}[32m" ++ s ++ "\u{001B}[0m"


dim : String -> String
dim s =
    "\u{001B}[2m" ++ s ++ "\u{001B}[0m"


modeLabel : Bool -> String
modeLabel full =
    if full then
        "Full rebuild"

    else
        "Incremental build"
