module BuildDb.TypeIndexTest exposing (suite)

import BuildDb.TypeIndex exposing (ProcessResult, TypeEntry, processEntries)
import Expect
import Json.Decode as Decode
import Test exposing (Test, describe, test)
import TypeSearch.Type as Type exposing (Type(..))


suite : Test
suite =
    describe "BuildDb.TypeIndex.processEntries"
        [ test "simple function type produces correct fingerprint, argCount, typeAstJson" <|
            \() ->
                let
                    entries =
                        [ { moduleName = "List"
                          , name = "head"
                          , kind = "value"
                          , typeRaw = "List a -> Maybe a"
                          }
                        ]

                    result =
                        processEntries 1 10 entries
                in
                case result.rows of
                    [ row ] ->
                        Expect.all
                            [ \r -> Expect.equal 1 r.packageId
                            , \r -> Expect.equal 10 r.versionId
                            , \r -> Expect.equal "List" r.moduleName
                            , \r -> Expect.equal "head" r.name
                            , \r -> Expect.equal "value" r.kind
                            , \r -> Expect.equal "List a -> Maybe a" r.typeRaw
                            , \r -> Expect.equal 1 r.argCount
                            , \r -> Expect.equal "F1:List,Maybe" r.fingerprint
                            , \r ->
                                -- Round-trip: typeAstJson decodes back to same AST
                                Decode.decodeString Type.decoder r.typeAstJson
                                    |> Expect.ok
                            ]
                            row

                    _ ->
                        Expect.fail ("Expected exactly 1 row, got " ++ String.fromInt (List.length result.rows))
        , test "parse error is counted, not in rows" <|
            \() ->
                let
                    entries =
                        [ { moduleName = "Bad"
                          , name = "broken"
                          , kind = "value"
                          , typeRaw = "-> ->"
                          }
                        ]

                    result =
                        processEntries 1 10 entries
                in
                Expect.all
                    [ \r -> Expect.equal [] r.rows
                    , \r -> Expect.equal 1 r.parseErrors
                    ]
                    result
        , test "empty input produces empty result" <|
            \() ->
                let
                    result =
                        processEntries 1 10 []
                in
                Expect.equal { rows = [], parseErrors = 0 } result
        , test "typeAstJson round-trips back to parsed AST" <|
            \() ->
                let
                    entries =
                        [ { moduleName = "Basics"
                          , name = "identity"
                          , kind = "value"
                          , typeRaw = "a -> a"
                          }
                        ]

                    result =
                        processEntries 1 10 entries
                in
                case result.rows of
                    [ row ] ->
                        case Decode.decodeString Type.decoder row.typeAstJson of
                            Ok ast ->
                                Expect.equal (Fn [ Var "a" ] (Var "a")) ast

                            Err err ->
                                Expect.fail (Decode.errorToString err)

                    _ ->
                        Expect.fail "Expected exactly 1 row"
        ]
