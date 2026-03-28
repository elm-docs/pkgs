module TypeSearch.FingerprintTest exposing (suite)

import Expect
import Test exposing (Test, describe, test)
import TypeSearch.Fingerprint as Fingerprint
import TypeSearch.Type exposing (Type(..))


suite : Test
suite =
    describe "Fingerprint"
        [ describe "fingerprint"
            [ test "(a -> Bool) -> List a -> List a => F2:Bool,List,List" <|
                \() ->
                    Fn
                        [ Fn [ Var "a" ] (App { home = "Basics", name = "Bool" } [])
                        , App { home = "List", name = "List" } [ Var "a" ]
                        ]
                        (App { home = "List", name = "List" } [ Var "a" ])
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F2:Bool,List,List"
            , test "Int -> String => F1:Int,String" <|
                \() ->
                    Fn
                        [ App { home = "Basics", name = "Int" } [] ]
                        (App { home = "String", name = "String" } [])
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F1:Int,String"
            , test "a -> b -> a => F2:" <|
                \() ->
                    Fn [ Var "a", Var "b" ] (Var "a")
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F2:"
            , test "non-function type => F0:Int" <|
                \() ->
                    App { home = "Basics", name = "Int" } []
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F0:Int"
            , test "List a => F0:List" <|
                \() ->
                    App { home = "List", name = "List" } [ Var "a" ]
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F0:List"
            , test "concretes are sorted" <|
                \() ->
                    Fn
                        [ App { home = "String", name = "String" } [] ]
                        (App { home = "Basics", name = "Int" } [])
                        |> Fingerprint.fingerprint
                        |> Expect.equal "F1:Int,String"
            ]
        , describe "countArgs"
            [ test "fn with 2 args => 2" <|
                \() ->
                    Fn [ Var "a", Var "b" ] (Var "c")
                        |> Fingerprint.countArgs
                        |> Expect.equal 2
            , test "non-fn => 0" <|
                \() ->
                    Var "a"
                        |> Fingerprint.countArgs
                        |> Expect.equal 0
            ]
        , describe "fingerprintCompatible"
            [ test "same fingerprint is compatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F2:Bool,List,List" "F2:Bool,List,List"
                        |> Expect.equal True
            , test "arg count ±1 is compatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F2:Bool" "F1:Bool"
                        |> Expect.equal True
            , test "arg count ±2 is incompatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F3:Bool" "F1:Bool"
                        |> Expect.equal False
            , test "shared concrete is compatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F1:Int,String" "F1:Bool,Int"
                        |> Expect.equal True
            , test "no shared concrete is incompatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F1:Int,String" "F1:Bool,Char"
                        |> Expect.equal False
            , test "query with no concretes is compatible with anything" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F1:" "F1:Bool,Int"
                        |> Expect.equal True
            , test "candidate with no concretes is compatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F1:Int" "F1:"
                        |> Expect.equal True
            , test "both no concretes is compatible" <|
                \() ->
                    Fingerprint.fingerprintCompatible "F1:" "F1:"
                        |> Expect.equal True
            ]
        ]
