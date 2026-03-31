module TextSearch exposing (run)

{-| CLI entry point for searching Elm packages by keyword.

Searches package names, authors, and summaries using substring matching
with pre-computed popularity ranks.
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
import Shared.CliHelpers exposing (parseIntOpt)
import Shared.Format exposing (formatFloat)
import TextSearch.Search as Search exposing (SearchResult)


type alias CliOptions =
    { query : String
    , db : String
    , limit : Int
    , json : Bool
    , projectRoot : Maybe String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            fetchAllResults options
                |> BackendTask.andThen
                    (\results ->
                        let
                            limited : List SearchResult
                            limited =
                                Search.search
                                    { limit = options.limit }
                                    results
                        in
                        if options.json then
                            Script.log (resultsToJson limited)

                        else
                            Script.log (formatResults options.query limited)
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
                |> with (Option.flag "json")
                |> with (Option.optionalKeywordArg "project-root")
            )


-- DATABASE


fetchAllResults : CliOptions -> BackendTask FatalError (List SearchResult)
fetchAllResults options =
    case options.projectRoot of
        Nothing ->
            searchPackages options.db options.query options.limit

        Just projectRoot ->
            readProjectInfo projectRoot
                |> BackendTask.andThen
                    (\projectInfo ->
                        let
                            directDeps : List String
                            directDeps =
                                ElmJson.directDeps projectInfo
                        in
                        searchPackagesFiltered options.db options.query options.limit directDeps
                    )


readProjectInfo : String -> BackendTask FatalError ElmJson.ProjectInfo
readProjectInfo projectRoot =
    BackendTask.Custom.run "readProjectInfo"
        (Encode.object [ ( "projectRoot", Encode.string projectRoot ) ])
        ElmJson.decoder
        |> BackendTask.allowFatal


searchPackages : String -> String -> Int -> BackendTask FatalError (List SearchResult)
searchPackages dbPath query limit =
    BackendTask.Custom.run "searchPackages"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "query", Encode.string query )
            , ( "limit", Encode.int limit )
            ]
        )
        (Decode.list resultDecoder)
        |> BackendTask.allowFatal


searchPackagesFiltered : String -> String -> Int -> List String -> BackendTask FatalError (List SearchResult)
searchPackagesFiltered dbPath query limit allowedPackages =
    BackendTask.Custom.run "searchPackagesFiltered"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "query", Encode.string query )
            , ( "limit", Encode.int limit )
            , ( "allowedPackages", Encode.list Encode.string allowedPackages )
            ]
        )
        (Decode.list resultDecoder)
        |> BackendTask.allowFatal


resultDecoder : Decode.Decoder SearchResult
resultDecoder =
    Decode.map4 SearchResult
        (Decode.field "package" Decode.string)
        (Decode.field "summary" Decode.string)
        (Decode.field "rank" Decode.float)
        (Decode.field "stars" Decode.int)



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
        rankStr : String
        rankStr =
            formatFloat 1 r.rank
    in
    "  "
        ++ green r.package
        ++ " "
        ++ dim ("★ " ++ String.fromInt r.stars)
        ++ "\n    "
        ++ dim r.summary
        ++ "  "
        ++ dim ("[" ++ rankStr ++ "]")


resultsToJson : List SearchResult -> String
resultsToJson results =
    Encode.list resultToJson results
        |> Encode.encode 2


resultToJson : SearchResult -> Encode.Value
resultToJson r =
    Encode.object
        [ ( "package", Encode.string r.package )
        , ( "summary", Encode.string r.summary )
        , ( "rank", Encode.float r.rank )
        , ( "stars", Encode.int r.stars )
        ]



