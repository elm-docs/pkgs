module TypeSearch.NormalizeTest exposing (suite)

import Expect
import Test exposing (Test, describe, test)
import TypeSearch.Normalize as Normalize
import TypeSearch.Type exposing (Type(..))


suite : Test
suite =
    describe "Normalize"
        [ test "x -> y -> x becomes a -> b -> a" <|
            \() ->
                Fn [ Var "x", Var "y" ] (Var "x")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "a", Var "b" ] (Var "a"))
        , test "foo -> bar -> foo becomes a -> b -> a" <|
            \() ->
                Fn [ Var "foo", Var "bar" ] (Var "foo")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "a", Var "b" ] (Var "a"))
        , test "reserved var number is preserved" <|
            \() ->
                Fn [ Var "number" ] (Var "x")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "number" ] (Var "a"))
        , test "reserved var comparable is preserved" <|
            \() ->
                Fn [ Var "comparable" ] (Var "x")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "comparable" ] (Var "a"))
        , test "reserved var appendable is preserved" <|
            \() ->
                Fn [ Var "appendable" ] (Var "x")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "appendable" ] (Var "a"))
        , test "reserved var compappend is preserved" <|
            \() ->
                Fn [ Var "compappend" ] (Var "x")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "compappend" ] (Var "a"))
        , test "already canonical stays unchanged" <|
            \() ->
                Fn [ Var "a", Var "b" ] (Var "a")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "a", Var "b" ] (Var "a"))
        , test "single var normalizes to a" <|
            \() ->
                Var "z"
                    |> Normalize.normalize
                    |> Expect.equal (Var "a")
        , test "normalizes vars inside App args" <|
            \() ->
                App { home = "List", name = "List" } [ Var "x" ]
                    |> Normalize.normalize
                    |> Expect.equal (App { home = "List", name = "List" } [ Var "a" ])
        , test "normalizes vars inside Tuple" <|
            \() ->
                Tuple [ Var "x", Var "y" ]
                    |> Normalize.normalize
                    |> Expect.equal (Tuple [ Var "a", Var "b" ])
        , test "normalizes vars inside Record" <|
            \() ->
                Record [ ( "x", Var "foo" ) ] (Just "bar")
                    |> Normalize.normalize
                    |> Expect.equal (Record [ ( "x", Var "b" ) ] (Just "a"))
        , test "no vars returns same type" <|
            \() ->
                App { home = "Basics", name = "Int" } []
                    |> Normalize.normalize
                    |> Expect.equal (App { home = "Basics", name = "Int" } [])
        , test "many vars use sequential letters" <|
            \() ->
                Fn [ Var "z", Var "y", Var "x" ] (Var "w")
                    |> Normalize.normalize
                    |> Expect.equal (Fn [ Var "a", Var "b", Var "c" ] (Var "d"))
        ]
