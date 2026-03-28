module TypeSearch.TypeTest exposing (suite)

import Expect
import Json.Decode as Decode
import Test exposing (Test, describe, test)
import TypeSearch.Type as Type exposing (Type(..))


suite : Test
suite =
    describe "Type decoder"
        [ test "decodes a var" <|
            \() ->
                """{"tag":"var","name":"a"}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Var "a"))
        , test "decodes an app with no args" <|
            \() ->
                """{"tag":"app","name":{"home":"Basics","name":"Int"},"args":[]}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (App { home = "Basics", name = "Int" } []))
        , test "decodes an app with args" <|
            \() ->
                """{"tag":"app","name":{"home":"List","name":"List"},"args":[{"tag":"var","name":"a"}]}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (App { home = "List", name = "List" } [ Var "a" ]))
        , test "decodes a fn" <|
            \() ->
                """{"tag":"fn","args":[{"tag":"var","name":"a"}],"result":{"tag":"var","name":"b"}}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Fn [ Var "a" ] (Var "b")))
        , test "decodes a tuple" <|
            \() ->
                """{"tag":"tuple","args":[{"tag":"var","name":"a"},{"tag":"var","name":"b"}]}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Tuple [ Var "a", Var "b" ]))
        , test "decodes an empty tuple (unit)" <|
            \() ->
                """{"tag":"tuple","args":[]}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Tuple []))
        , test "decodes a record" <|
            \() ->
                """{"tag":"record","fields":[["x",{"tag":"app","name":{"home":"Basics","name":"Int"},"args":[]}]],"ext":null}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Record [ ( "x", App { home = "Basics", name = "Int" } [] ) ] Nothing))
        , test "decodes an extensible record" <|
            \() ->
                """{"tag":"record","fields":[["x",{"tag":"app","name":{"home":"Basics","name":"Int"},"args":[]}]],"ext":"r"}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.equal (Ok (Record [ ( "x", App { home = "Basics", name = "Int" } [] ) ] (Just "r")))
        , test "decodes nested fn" <|
            \() ->
                let
                    json =
                        """{"tag":"fn","args":[{"tag":"fn","args":[{"tag":"var","name":"a"}],"result":{"tag":"var","name":"b"}}],"result":{"tag":"app","name":{"home":"List","name":"List"},"args":[{"tag":"var","name":"b"}]}}"""
                in
                Decode.decodeString Type.decoder json
                    |> Expect.equal
                        (Ok
                            (Fn
                                [ Fn [ Var "a" ] (Var "b") ]
                                (App { home = "List", name = "List" } [ Var "b" ])
                            )
                        )
        , test "fails on unknown tag" <|
            \() ->
                """{"tag":"unknown","name":"x"}"""
                    |> Decode.decodeString Type.decoder
                    |> Expect.err
        ]
