module TypeSearch.ParseTest exposing (suite)

import Expect
import Test exposing (Test, describe, test)
import TypeSearch.Parse as Parse
import TypeSearch.Type exposing (Type(..))


suite : Test
suite =
    describe "Parse"
        [ describe "parseLenient"
            [ test "simple var" <|
                \() ->
                    Parse.parseLenient "a"
                        |> Expect.equal (Ok (Var "a"))
            , test "Int resolves to Basics.Int" <|
                \() ->
                    Parse.parseLenient "Int"
                        |> Expect.equal (Ok (App { home = "Basics", name = "Int" } []))
            , test "Float resolves to Basics.Float" <|
                \() ->
                    Parse.parseLenient "Float"
                        |> Expect.equal (Ok (App { home = "Basics", name = "Float" } []))
            , test "Bool resolves to Basics.Bool" <|
                \() ->
                    Parse.parseLenient "Bool"
                        |> Expect.equal (Ok (App { home = "Basics", name = "Bool" } []))
            , test "String resolves to String.String" <|
                \() ->
                    Parse.parseLenient "String"
                        |> Expect.equal (Ok (App { home = "String", name = "String" } []))
            , test "List a" <|
                \() ->
                    Parse.parseLenient "List a"
                        |> Expect.equal (Ok (App { home = "List", name = "List" } [ Var "a" ]))
            , test "Maybe a" <|
                \() ->
                    Parse.parseLenient "Maybe a"
                        |> Expect.equal (Ok (App { home = "Maybe", name = "Maybe" } [ Var "a" ]))
            , test "Result x a" <|
                \() ->
                    Parse.parseLenient "Result x a"
                        |> Expect.equal (Ok (App { home = "Result", name = "Result" } [ Var "x", Var "a" ]))
            , test "simple function a -> b" <|
                \() ->
                    Parse.parseLenient "a -> b"
                        |> Expect.equal (Ok (Fn [ Var "a" ] (Var "b")))
            , test "multi-arg function a -> b -> c" <|
                \() ->
                    Parse.parseLenient "a -> b -> c"
                        |> Expect.equal (Ok (Fn [ Var "a", Var "b" ] (Var "c")))
            , test "higher-order function (a -> b) -> List a -> List b" <|
                \() ->
                    Parse.parseLenient "(a -> b) -> List a -> List b"
                        |> Expect.equal
                            (Ok
                                (Fn
                                    [ Fn [ Var "a" ] (Var "b")
                                    , App { home = "List", name = "List" } [ Var "a" ]
                                    ]
                                    (App { home = "List", name = "List" } [ Var "b" ])
                                )
                            )
            , test "unit tuple ()" <|
                \() ->
                    Parse.parseLenient "()"
                        |> Expect.equal (Ok (Tuple []))
            , test "pair (a, b)" <|
                \() ->
                    Parse.parseLenient "(a, b)"
                        |> Expect.equal (Ok (Tuple [ Var "a", Var "b" ]))
            , test "triple (a, b, c)" <|
                \() ->
                    Parse.parseLenient "(a, b, c)"
                        |> Expect.equal (Ok (Tuple [ Var "a", Var "b", Var "c" ]))
            , test "empty record {}" <|
                \() ->
                    Parse.parseLenient "{}"
                        |> Expect.equal (Ok (Record [] Nothing))
            , test "record { x : Int }" <|
                \() ->
                    Parse.parseLenient "{ x : Int }"
                        |> Expect.equal (Ok (Record [ ( "x", App { home = "Basics", name = "Int" } [] ) ] Nothing))
            , test "extensible record { a | x : Int }" <|
                \() ->
                    Parse.parseLenient "{ a | x : Int }"
                        |> Expect.equal (Ok (Record [ ( "x", App { home = "Basics", name = "Int" } [] ) ] (Just "a")))
            , test "Dict resolves" <|
                \() ->
                    Parse.parseLenient "Dict k v"
                        |> Expect.equal (Ok (App { home = "Dict", name = "Dict" } [ Var "k", Var "v" ]))
            , test "Html resolves" <|
                \() ->
                    Parse.parseLenient "Html msg"
                        |> Expect.equal (Ok (App { home = "Html", name = "Html" } [ Var "msg" ]))
            , test "Cmd resolves to Platform.Cmd" <|
                \() ->
                    Parse.parseLenient "Cmd msg"
                        |> Expect.equal (Ok (App { home = "Platform.Cmd", name = "Cmd" } [ Var "msg" ]))
            , test "unknown uppercase stays unqualified" <|
                \() ->
                    Parse.parseLenient "Foo"
                        |> Expect.equal (Ok (App { home = "", name = "Foo" } []))
            ]
        , describe "parseStrict"
            [ test "qualified name Basics.Int" <|
                \() ->
                    Parse.parseStrict "Basics.Int"
                        |> Expect.equal (Ok (App { home = "Basics", name = "Int" } []))
            , test "qualified name Platform.Cmd.Cmd" <|
                \() ->
                    Parse.parseStrict "Platform.Cmd.Cmd"
                        |> Expect.equal (Ok (App { home = "Platform.Cmd", name = "Cmd" } []))
            , test "unqualified name in strict mode stays unqualified" <|
                \() ->
                    Parse.parseStrict "Int"
                        |> Expect.equal (Ok (App { home = "", name = "Int" } []))
            , test "List.List a" <|
                \() ->
                    Parse.parseStrict "List.List a"
                        |> Expect.equal (Ok (App { home = "List", name = "List" } [ Var "a" ]))
            , test "complex strict: (a -> b) -> List.List a -> List.List b" <|
                \() ->
                    Parse.parseStrict "(a -> b) -> List.List a -> List.List b"
                        |> Expect.equal
                            (Ok
                                (Fn
                                    [ Fn [ Var "a" ] (Var "b")
                                    , App { home = "List", name = "List" } [ Var "a" ]
                                    ]
                                    (App { home = "List", name = "List" } [ Var "b" ])
                                )
                            )
            ]
        , describe "error cases"
            [ test "empty string" <|
                \() ->
                    Parse.parseLenient ""
                        |> Expect.err
            , test "trailing garbage" <|
                \() ->
                    Parse.parseLenient "Int +"
                        |> Expect.err
            ]
        , describe "multi-field record" <|
            [ test "{ x : Int, y : String }" <|
                \() ->
                    Parse.parseLenient "{ x : Int, y : String }"
                        |> Expect.equal
                            (Ok
                                (Record
                                    [ ( "x", App { home = "Basics", name = "Int" } [] )
                                    , ( "y", App { home = "String", name = "String" } [] )
                                    ]
                                    Nothing
                                )
                            )
            ]
        , describe "parenthesized type" <|
            [ test "(Int) is just Int" <|
                \() ->
                    Parse.parseLenient "(Int)"
                        |> Expect.equal (Ok (App { home = "Basics", name = "Int" } []))
            ]
        ]
