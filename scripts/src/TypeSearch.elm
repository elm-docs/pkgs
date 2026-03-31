module TypeSearch exposing (run)

{-| CLI entry point for searching Elm packages by type signature.

Parses a type query, normalizes it, then finds functions with similar
type signatures using fingerprint pre-filtering and structural distance.
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
import ProjectContext.ElmJson as ElmJson
import Shared.Ansi exposing (bold, dim, green)
import Shared.CliHelpers exposing (parseFloatOpt, parseIntOpt)
import Shared.Format exposing (formatFloat)
import TypeSearch.Fingerprint as Fingerprint
import TypeSearch.Normalize as Normalize
import TypeSearch.Parse as Parse
import TypeSearch.Search as Search exposing (Candidate, SearchResult)
import TypeSearch.Type as Type exposing (Type)


type alias CliOptions =
    { query : String
    , db : String
    , limit : Int
    , threshold : Float
    , json : Bool
    , projectRoot : Maybe String
    , projectDb : Maybe String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            case Parse.parseLenient options.query of
                Err err ->
                    Script.log ("Error: Failed to parse type query: " ++ err)
                        |> BackendTask.andThen (\() -> BackendTask.fail (FatalError.build { title = "Parse Error", body = err }))

                Ok parsed ->
                    let
                        queryAst : Type
                        queryAst =
                            Normalize.normalize parsed

                        queryFp : String
                        queryFp =
                            Fingerprint.fingerprint queryAst

                        queryArgCount : Int
                        queryArgCount =
                            Fingerprint.countArgs queryAst

                        minArgs : Int
                        minArgs =
                            max 0 (queryArgCount - 1)

                        maxArgs : Int
                        maxArgs =
                            queryArgCount + 1
                    in
                    fetchAllCandidates options minArgs maxArgs
                        |> BackendTask.andThen
                            (\candidates ->
                                let
                                    results : List SearchResult
                                    results =
                                        Search.search
                                            { limit = options.limit
                                            , threshold = options.threshold
                                            }
                                            queryAst
                                            queryFp
                                            candidates
                                in
                                if options.json then
                                    Script.log (resultsToJson results)

                                else
                                    Script.log (formatResults options.query results)
                            )
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with (Option.requiredPositionalArg "query")
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "../db/elm-packages.db"
                    )
                |> with
                    (Option.optionalKeywordArg "limit"
                        |> Option.validateMap (parseIntOpt "limit" 20)
                    )
                |> with
                    (Option.optionalKeywordArg "threshold"
                        |> Option.validateMap (parseFloatOpt "threshold" 0.125)
                    )
                |> with (Option.flag "json")
                |> with (Option.optionalKeywordArg "project-root")
                |> with (Option.optionalKeywordArg "project-db")
            )


-- DATABASE


fetchAllCandidates : CliOptions -> Int -> Int -> BackendTask FatalError (List Candidate)
fetchAllCandidates options minArgs maxArgs =
    case options.projectRoot of
        Nothing ->
            fetchCandidates options.db minArgs maxArgs

        Just projectRoot ->
            readProjectInfo projectRoot
                |> BackendTask.andThen
                    (\projectInfo ->
                        let
                            directDeps : List String
                            directDeps =
                                ElmJson.directDeps projectInfo
                        in
                        fetchFilteredCandidates options.db minArgs maxArgs directDeps
                            |> BackendTask.andThen
                                (\globalCandidates ->
                                    case options.projectDb of
                                        Nothing ->
                                            BackendTask.succeed globalCandidates

                                        Just projectDb ->
                                            fetchCandidates projectDb minArgs maxArgs
                                                |> BackendTask.map
                                                    (\localCandidates ->
                                                        globalCandidates ++ localCandidates
                                                    )
                                )
                    )


readProjectInfo : String -> BackendTask FatalError ElmJson.ProjectInfo
readProjectInfo projectRoot =
    BackendTask.Custom.run "readProjectInfo"
        (Encode.object [ ( "projectRoot", Encode.string projectRoot ) ])
        ElmJson.decoder
        |> BackendTask.allowFatal


fetchCandidates : String -> Int -> Int -> BackendTask FatalError (List Candidate)
fetchCandidates dbPath minArgs maxArgs =
    BackendTask.Custom.run "queryTypeIndex"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "minArgs", Encode.int minArgs )
            , ( "maxArgs", Encode.int maxArgs )
            ]
        )
        (Decode.list candidateDecoder)
        |> BackendTask.allowFatal


fetchFilteredCandidates : String -> Int -> Int -> List String -> BackendTask FatalError (List Candidate)
fetchFilteredCandidates dbPath minArgs maxArgs allowedPackages =
    BackendTask.Custom.run "queryTypeIndexFiltered"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "minArgs", Encode.int minArgs )
            , ( "maxArgs", Encode.int maxArgs )
            , ( "allowedPackages", Encode.list Encode.string allowedPackages )
            ]
        )
        (Decode.list candidateDecoder)
        |> BackendTask.allowFatal


candidateDecoder : Decode.Decoder Candidate
candidateDecoder =
    Decode.map8 Candidate
        (Decode.field "module_name" Decode.string)
        (Decode.field "name" Decode.string)
        (Decode.field "kind" Decode.string)
        (Decode.field "type_raw" Decode.string)
        (Decode.field "type_ast" (Decode.string |> Decode.andThen decodeTypeAst))
        (Decode.field "fingerprint" Decode.string)
        (Decode.field "org" Decode.string)
        (Decode.field "pkg_name" Decode.string)


decodeTypeAst : String -> Decode.Decoder Type
decodeTypeAst jsonStr =
    case Decode.decodeString Type.decoder jsonStr of
        Ok t ->
            Decode.succeed t

        Err err ->
            Decode.fail (Decode.errorToString err)



-- OUTPUT FORMATTING


formatResults : String -> List SearchResult -> String
formatResults query results =
    if List.isEmpty results then
        "No results found."

    else
        let
            header : String
            header =
                bold ("Results for: " ++ query) ++ "\n"

            body : String
            body =
                results
                    |> List.map formatResult
                    |> String.join "\n"

            footer : String
            footer =
                "\n" ++ dim (String.fromInt (List.length results) ++ " result(s)")
        in
        header ++ "\n" ++ body ++ "\n" ++ footer


formatResult : SearchResult -> String
formatResult r =
    let
        dist : String
        dist =
            formatFloat 3 r.distance
    in
    "  "
        ++ green (r.moduleName ++ "." ++ r.name)
        ++ " "
        ++ dim ("(" ++ r.package ++ ")")
        ++ "\n    "
        ++ dim r.typeRaw
        ++ "  "
        ++ dim ("[" ++ dist ++ "]")


resultsToJson : List SearchResult -> String
resultsToJson results =
    Encode.list resultToJson results
        |> Encode.encode 2


resultToJson : SearchResult -> Encode.Value
resultToJson r =
    Encode.object
        [ ( "package", Encode.string r.package )
        , ( "module", Encode.string r.moduleName )
        , ( "name", Encode.string r.name )
        , ( "kind", Encode.string r.kind )
        , ( "typeRaw", Encode.string r.typeRaw )
        , ( "distance", Encode.float r.distance )
        ]



