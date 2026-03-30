module TextSearch exposing (run)

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
import TextSearch.Rank exposing (RawCandidate)
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
            fetchAllCandidates options
                |> BackendTask.andThen
                    (\candidates ->
                        let
                            results : List SearchResult
                            results =
                                Search.search
                                    { limit = options.limit }
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
                |> with (Option.flag "json")
                |> with (Option.optionalKeywordArg "project-root")
            )


parseIntOpt : String -> Int -> Maybe String -> Result String Int
parseIntOpt name default_ maybeStr =
    case maybeStr of
        Nothing ->
            Ok default_

        Just str ->
            case String.toInt str of
                Just n ->
                    Ok n

                Nothing ->
                    Err ("Invalid --" ++ name ++ " value: " ++ str)



-- DATABASE


fetchAllCandidates : CliOptions -> BackendTask FatalError (List RawCandidate)
fetchAllCandidates options =
    case options.projectRoot of
        Nothing ->
            fetchCandidates options.db options.query

        Just projectRoot ->
            readProjectInfo projectRoot
                |> BackendTask.andThen
                    (\projectInfo ->
                        let
                            directDeps : List String
                            directDeps =
                                ElmJson.directDeps projectInfo
                        in
                        fetchFilteredCandidates options.db options.query directDeps
                    )


readProjectInfo : String -> BackendTask FatalError ElmJson.ProjectInfo
readProjectInfo projectRoot =
    BackendTask.Custom.run "readProjectInfo"
        (Encode.object [ ( "projectRoot", Encode.string projectRoot ) ])
        ElmJson.decoder
        |> BackendTask.allowFatal


fetchCandidates : String -> String -> BackendTask FatalError (List RawCandidate)
fetchCandidates dbPath query =
    BackendTask.Custom.run "queryTextSearch"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "query", Encode.string query )
            ]
        )
        (Decode.list candidateDecoder)
        |> BackendTask.allowFatal


fetchFilteredCandidates : String -> String -> List String -> BackendTask FatalError (List RawCandidate)
fetchFilteredCandidates dbPath query allowedPackages =
    BackendTask.Custom.run "queryTextSearchFiltered"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "query", Encode.string query )
            , ( "allowedPackages", Encode.list Encode.string allowedPackages )
            ]
        )
        (Decode.list candidateDecoder)
        |> BackendTask.allowFatal


candidateDecoder : Decode.Decoder RawCandidate
candidateDecoder =
    Decode.map6 RawCandidate
        (Decode.field "package" Decode.string)
        (Decode.field "summary" Decode.string)
        (Decode.field "text_score" Decode.float)
        (Decode.field "match_count" Decode.int)
        (Decode.field "stars" Decode.int)
        (Decode.field "summary_match" Decode.bool)



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
        score : String
        score =
            formatFloat 3 r.score
    in
    "  "
        ++ green r.package
        ++ " "
        ++ dim ("★ " ++ String.fromInt r.stars)
        ++ "\n    "
        ++ dim r.summary
        ++ "  "
        ++ dim ("[" ++ score ++ "]")


formatFloat : Int -> Float -> String
formatFloat decimals f =
    let
        multiplier : Float
        multiplier =
            toFloat (10 ^ decimals)

        rounded : Float
        rounded =
            toFloat (round (f * multiplier)) / multiplier

        str : String
        str =
            String.fromFloat rounded

        parts : List String
        parts =
            String.split "." str
    in
    case parts of
        [ whole, frac ] ->
            whole ++ "." ++ String.padRight decimals '0' frac

        [ whole ] ->
            whole ++ "." ++ String.repeat decimals "0"

        _ ->
            str


resultsToJson : List SearchResult -> String
resultsToJson results =
    Encode.list resultToJson results
        |> Encode.encode 2


resultToJson : SearchResult -> Encode.Value
resultToJson r =
    Encode.object
        [ ( "package", Encode.string r.package )
        , ( "summary", Encode.string r.summary )
        , ( "score", Encode.float r.score )
        , ( "stars", Encode.int r.stars )
        ]



-- ANSI helpers


bold : String -> String
bold s =
    "\u{001B}[1m" ++ s ++ "\u{001B}[0m"


green : String -> String
green s =
    "\u{001B}[32m" ++ s ++ "\u{001B}[0m"


dim : String -> String
dim s =
    "\u{001B}[2m" ++ s ++ "\u{001B}[0m"
