module TypeSearch.Parse exposing (parseLenient, parseStrict)

import Dict exposing (Dict)
import Parser exposing ((|.), (|=), Parser)
import Set
import TypeSearch.Type exposing (QualifiedName, Type(..))


parseLenient : String -> Result String Type
parseLenient src =
    parseWith True src


parseStrict : String -> Result String Type
parseStrict src =
    parseWith False src


parseWith : Bool -> String -> Result String Type
parseWith lenient src =
    case Parser.run (typeParser lenient |. Parser.end) src of
        Ok t ->
            Ok t

        Err deadEnds ->
            Err (deadEndsToString deadEnds)


deadEndsToString : List Parser.DeadEnd -> String
deadEndsToString deadEnds =
    case deadEnds of
        [] ->
            "Unknown parse error"

        first :: _ ->
            "Parse error at row "
                ++ String.fromInt first.row
                ++ ", col "
                ++ String.fromInt first.col



-- PARSER


typeParser : Bool -> Parser Type
typeParser lenient =
    fnTypeParser lenient


fnTypeParser : Bool -> Parser Type
fnTypeParser lenient =
    appTypeParser lenient
        |> Parser.andThen
            (\first ->
                arrowLoop lenient [ first ]
            )


arrowLoop : Bool -> List Type -> Parser Type
arrowLoop lenient acc =
    Parser.oneOf
        [ Parser.backtrackable
            (Parser.succeed identity
                |. Parser.token " -> "
                |= appTypeParser lenient
            )
            |> Parser.andThen (\next -> arrowLoop lenient (next :: acc))
        , Parser.lazy
            (\() ->
                let
                    reversed =
                        List.reverse acc
                in
                case reversed of
                    [ single ] ->
                        Parser.succeed single

                    _ ->
                        let
                            args =
                                List.take (List.length reversed - 1) reversed

                            result =
                                List.drop (List.length reversed - 1) reversed
                                    |> List.head
                                    |> Maybe.withDefault (Tuple [])
                        in
                        Parser.succeed (Fn args result)
            )
        ]


appTypeParser : Bool -> Parser Type
appTypeParser lenient =
    atomTypeParser lenient
        |> Parser.andThen
            (\head ->
                appArgLoop lenient head []
            )


appArgLoop : Bool -> Type -> List Type -> Parser Type
appArgLoop lenient head args =
    Parser.oneOf
        [ Parser.backtrackable
            (Parser.succeed identity
                |. Parser.symbol " "
                |= atomTypeParser lenient
            )
            |> Parser.andThen
                (\arg ->
                    appArgLoop lenient head (args ++ [ arg ])
                )
        , Parser.lazy
            (\() ->
                if List.isEmpty args then
                    Parser.succeed head

                else
                    case head of
                        App qname headArgs ->
                            Parser.succeed (App qname (headArgs ++ args))

                        Var varName ->
                            Parser.succeed (App (resolveName lenient varName) args)

                        _ ->
                            Parser.problem "Cannot apply arguments to this type"
            )
        ]


atomTypeParser : Bool -> Parser Type
atomTypeParser lenient =
    Parser.oneOf
        [ parenOrTupleParser lenient
        , recordParser lenient
        , qualifiedNameParser lenient
        , varParser
        ]


parenOrTupleParser : Bool -> Parser Type
parenOrTupleParser lenient =
    Parser.succeed identity
        |. Parser.symbol "("
        |. Parser.spaces
        |= Parser.oneOf
            [ -- Unit tuple ()
              Parser.succeed (Tuple [])
                |. Parser.symbol ")"
            , -- Parenthesized or tuple
              Parser.lazy (\() -> typeParser lenient)
                |> Parser.andThen
                    (\first ->
                        Parser.oneOf
                            [ -- Just parenthesized
                              Parser.succeed first
                                |. Parser.spaces
                                |. Parser.symbol ")"
                            , -- Tuple with more elements
                              tupleRestParser lenient [ first ]
                            ]
                    )
            ]


tupleRestParser : Bool -> List Type -> Parser Type
tupleRestParser lenient acc =
    Parser.succeed identity
        |. Parser.spaces
        |. Parser.symbol ","
        |. Parser.spaces
        |= Parser.lazy (\() -> typeParser lenient)
        |> Parser.andThen
            (\next ->
                let
                    newAcc =
                        acc ++ [ next ]
                in
                Parser.oneOf
                    [ Parser.succeed (Tuple newAcc)
                        |. Parser.spaces
                        |. Parser.symbol ")"
                    , tupleRestParser lenient newAcc
                    ]
            )


recordParser : Bool -> Parser Type
recordParser lenient =
    Parser.succeed identity
        |. Parser.symbol "{"
        |. Parser.spaces
        |= Parser.oneOf
            [ -- Empty record {}
              Parser.succeed (Record [] Nothing)
                |. Parser.symbol "}"
            , -- Record with fields (possibly extensible)
              Parser.lazy (\() -> recordBodyParser lenient)
            ]


recordBodyParser : Bool -> Parser Type
recordBodyParser lenient =
    Parser.oneOf
        [ -- Extensible record: { var | fields }
          Parser.backtrackable
            (Parser.succeed Tuple.pair
                |= identParser
                |. Parser.spaces
                |. Parser.symbol "|"
                |. Parser.spaces
                |= recordFieldsParser lenient
            )
            |> Parser.map (\( ext, fields ) -> Record fields (Just ext))
            |> Parser.andThen (\r -> Parser.succeed r |. Parser.spaces |. Parser.symbol "}")
        , -- Regular record: { field : Type, ... }
          recordFieldsParser lenient
            |> Parser.map (\fields -> Record fields Nothing)
            |> Parser.andThen (\r -> Parser.succeed r |. Parser.spaces |. Parser.symbol "}")
        ]


recordFieldsParser : Bool -> Parser (List ( String, Type ))
recordFieldsParser lenient =
    recordFieldParser lenient
        |> Parser.andThen
            (\first ->
                recordFieldsLoop lenient [ first ]
            )


recordFieldsLoop : Bool -> List ( String, Type ) -> Parser (List ( String, Type ))
recordFieldsLoop lenient acc =
    Parser.oneOf
        [ Parser.backtrackable
            (Parser.succeed identity
                |. Parser.spaces
                |. Parser.symbol ","
                |. Parser.spaces
                |= recordFieldParser lenient
            )
            |> Parser.andThen (\field -> recordFieldsLoop lenient (acc ++ [ field ]))
        , Parser.succeed acc
        ]


recordFieldParser : Bool -> Parser ( String, Type )
recordFieldParser lenient =
    Parser.succeed Tuple.pair
        |= identParser
        |. Parser.spaces
        |. Parser.symbol ":"
        |. Parser.spaces
        |= Parser.lazy (\() -> typeParser lenient)


qualifiedNameParser : Bool -> Parser Type
qualifiedNameParser lenient =
    upperIdentParser
        |> Parser.andThen
            (\first ->
                qualifiedSegmentsLoop lenient [ first ]
            )


qualifiedSegmentsLoop : Bool -> List String -> Parser Type
qualifiedSegmentsLoop lenient segments =
    Parser.oneOf
        [ Parser.backtrackable
            (Parser.succeed identity
                |. Parser.symbol "."
                |= upperIdentParser
            )
            |> Parser.andThen
                (\next ->
                    qualifiedSegmentsLoop lenient (segments ++ [ next ])
                )
        , Parser.lazy
            (\() ->
                let
                    typeName =
                        List.reverse segments |> List.head |> Maybe.withDefault ""

                    home =
                        List.take (List.length segments - 1) segments
                            |> String.join "."

                    qname =
                        if home == "" && lenient then
                            resolveName True typeName

                        else
                            { home = home, name = typeName }
                in
                Parser.succeed (App qname [])
            )
        ]


varParser : Parser Type
varParser =
    identParser |> Parser.map Var


identParser : Parser String
identParser =
    Parser.variable
        { start = Char.isLower
        , inner = \c -> Char.isAlphaNum c || c == '_' || c == '\''
        , reserved = Set.empty
        }


upperIdentParser : Parser String
upperIdentParser =
    Parser.variable
        { start = Char.isUpper
        , inner = \c -> Char.isAlphaNum c || c == '_' || c == '\''
        , reserved = Set.empty
        }


resolveName : Bool -> String -> QualifiedName
resolveName lenient name =
    if lenient then
        case Dict.get name lenientResolveMap of
            Just qname ->
                qname

            Nothing ->
                { home = "", name = name }

    else
        { home = "", name = name }


lenientResolveMap : Dict String QualifiedName
lenientResolveMap =
    Dict.fromList
        [ ( "Int", { home = "Basics", name = "Int" } )
        , ( "Float", { home = "Basics", name = "Float" } )
        , ( "Bool", { home = "Basics", name = "Bool" } )
        , ( "String", { home = "String", name = "String" } )
        , ( "Char", { home = "Char", name = "Char" } )
        , ( "Never", { home = "Basics", name = "Never" } )
        , ( "Order", { home = "Basics", name = "Order" } )
        , ( "List", { home = "List", name = "List" } )
        , ( "Maybe", { home = "Maybe", name = "Maybe" } )
        , ( "Result", { home = "Result", name = "Result" } )
        , ( "Cmd", { home = "Platform.Cmd", name = "Cmd" } )
        , ( "Sub", { home = "Platform.Sub", name = "Sub" } )
        , ( "Task", { home = "Task", name = "Task" } )
        , ( "Decoder", { home = "Json.Decode", name = "Decoder" } )
        , ( "Value", { home = "Json.Encode", name = "Value" } )
        , ( "Html", { home = "Html", name = "Html" } )
        , ( "Attribute", { home = "Html", name = "Attribute" } )
        , ( "Svg", { home = "Svg", name = "Svg" } )
        , ( "Program", { home = "Platform", name = "Program" } )
        , ( "Dict", { home = "Dict", name = "Dict" } )
        , ( "Set", { home = "Set", name = "Set" } )
        , ( "Array", { home = "Array", name = "Array" } )
        ]
