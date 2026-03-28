module TypeSearch exposing (run)

import BackendTask exposing (BackendTask)
import BackendTask.Custom
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Json.Decode as Decode
import Json.Encode as Encode
import Pages.Script as Script exposing (Script)
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
                        queryAst =
                            Normalize.normalize parsed

                        queryFp =
                            Fingerprint.fingerprint queryAst

                        queryArgCount =
                            Fingerprint.countArgs queryAst

                        minArgs =
                            max 0 (queryArgCount - 1)

                        maxArgs =
                            queryArgCount + 1
                    in
                    fetchCandidates options.db minArgs maxArgs
                        |> BackendTask.andThen
                            (\candidates ->
                                let
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


parseFloatOpt : String -> Float -> Maybe String -> Result String Float
parseFloatOpt name default_ maybeStr =
    case maybeStr of
        Nothing ->
            Ok default_

        Just str ->
            case String.toFloat str of
                Just f ->
                    Ok f

                Nothing ->
                    Err ("Invalid --" ++ name ++ " value: " ++ str)



-- DATABASE


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
            header =
                bold ("Results for: " ++ query) ++ "\n"

            body =
                results
                    |> List.map formatResult
                    |> String.join "\n"

            footer =
                "\n" ++ dim (String.fromInt (List.length results) ++ " result(s)")
        in
        header ++ "\n" ++ body ++ "\n" ++ footer


formatResult : SearchResult -> String
formatResult r =
    let
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


formatFloat : Int -> Float -> String
formatFloat decimals f =
    let
        multiplier =
            toFloat (10 ^ decimals)

        rounded =
            toFloat (round (f * multiplier)) / multiplier

        str =
            String.fromFloat rounded

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
        , ( "module", Encode.string r.moduleName )
        , ( "name", Encode.string r.name )
        , ( "kind", Encode.string r.kind )
        , ( "typeRaw", Encode.string r.typeRaw )
        , ( "distance", Encode.float r.distance )
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
