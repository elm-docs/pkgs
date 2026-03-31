module BuildProjectContext exposing (run)

{-| Builds a project-scoped database by ingesting local project docs
for use with --project type searches.
-}

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
import ProjectContext.ElmJson as ElmJson exposing (ProjectInfo)


type alias CliOptions =
    { projectRoot : String
    , db : String
    , full : Bool
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            Script.log "Building project context database..."
                |> BackendTask.andThen (\() -> readProjectInfo options.projectRoot)
                |> BackendTask.andThen
                    (\projectInfo ->
                        Script.log ("  Project: " ++ projectInfo.name)
                            |> BackendTask.andThen (\() -> generateLocalDocs options.projectRoot)
                            |> BackendTask.andThen
                                (\genResult ->
                                    case genResult.docsPath of
                                        Nothing ->
                                            Script.log
                                                ("  Warning: Could not generate docs: "
                                                    ++ Maybe.withDefault "(unknown error)" genResult.error
                                                )
                                                |> BackendTask.map (\() -> 0)

                                        Just docsPath ->
                                            initDb options.db options.full
                                                |> BackendTask.andThen
                                                    (\() ->
                                                        ingestLocalDocs
                                                            options.db
                                                            docsPath
                                                            projectInfo.name
                                                            projectInfo.version
                                                    )
                                                |> BackendTask.andThen
                                                    (\moduleCount ->
                                                        Script.log
                                                            ("  "
                                                                ++ String.fromInt moduleCount
                                                                ++ " modules ingested"
                                                            )
                                                            |> BackendTask.andThen
                                                                (\() -> typeIndexLoop options.db options.full 0 0 0)
                                                    )
                                )
                    )
                |> BackendTask.andThen
                    (\totalInserted ->
                        Script.log ("  " ++ String.fromInt totalInserted ++ " type index entries")
                            |> BackendTask.andThen (\() -> Script.log "Done.")
                    )
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with (Option.requiredKeywordArg "project-root")
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "~/.elm-docs/elm-packages.db"
                    )
                |> with (Option.flag "full")
            )



-- FFI CALLS


readProjectInfo : String -> BackendTask FatalError ProjectInfo
readProjectInfo projectRoot =
    BackendTask.Custom.run "readProjectInfo"
        (Encode.object [ ( "projectRoot", Encode.string projectRoot ) ])
        ElmJson.decoder
        |> BackendTask.allowFatal


type alias GenerateDocsResult =
    { docsPath : Maybe String
    , error : Maybe String
    }


generateLocalDocs : String -> BackendTask FatalError GenerateDocsResult
generateLocalDocs projectRoot =
    BackendTask.Custom.run "generateLocalDocs"
        (Encode.object [ ( "projectRoot", Encode.string projectRoot ) ])
        (Decode.map2 GenerateDocsResult
            (Decode.field "docsPath" (Decode.nullable Decode.string))
            (Decode.field "error" (Decode.nullable Decode.string))
        )
        |> BackendTask.allowFatal


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


ingestLocalDocs : String -> String -> String -> String -> BackendTask FatalError Int
ingestLocalDocs dbPath docsPath packageName version =
    BackendTask.Custom.run "ingestLocalDocsJson"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "docsJsonPath", Encode.string docsPath )
            , ( "packageName", Encode.string packageName )
            , ( "version", Encode.string version )
            ]
        )
        (Decode.field "modules" Decode.int)
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
                                (TypeIndex.processEntries pkg.packageId pkg.versionId pkg.entries).rows
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
