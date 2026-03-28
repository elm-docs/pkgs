module TypeSearch.DistanceTest exposing (suite)

import Expect exposing (FloatingPointTolerance(..))
import Test exposing (Test, describe, test)
import TypeSearch.Distance as Distance
import TypeSearch.Type exposing (Type(..))


suite : Test
suite =
    describe "Distance"
        [ describe "var matching"
            [ test "var vs var => 0.0" <|
                \() ->
                    Distance.distance (Var "a") (Var "b")
                        |> Expect.within (Absolute 0.001) 0.0
            , test "var vs concrete => 0.5 (medium penalty)" <|
                \() ->
                    Distance.distance (Var "a") (App { home = "Basics", name = "Int" } [])
                        |> Expect.within (Absolute 0.001) 0.5
            , test "number vs Int => 0.25 (low penalty)" <|
                \() ->
                    Distance.distance (Var "number") (App { home = "Basics", name = "Int" } [])
                        |> Expect.within (Absolute 0.001) 0.25
            , test "number vs Float => 0.25" <|
                \() ->
                    Distance.distance (Var "number") (App { home = "Basics", name = "Float" } [])
                        |> Expect.within (Absolute 0.001) 0.25
            , test "comparable vs String => 0.25" <|
                \() ->
                    Distance.distance (Var "comparable") (App { home = "String", name = "String" } [])
                        |> Expect.within (Absolute 0.001) 0.25
            , test "number vs String => 0.5 (not a reserved match)" <|
                \() ->
                    Distance.distance (Var "number") (App { home = "String", name = "String" } [])
                        |> Expect.within (Absolute 0.001) 0.5
            ]
        , describe "app matching"
            [ test "same app no args => 0.0" <|
                \() ->
                    Distance.distance
                        (App { home = "Basics", name = "Int" } [])
                        (App { home = "Basics", name = "Int" } [])
                        |> Expect.within (Absolute 0.001) 0.0
            , test "different app => 1.0" <|
                \() ->
                    Distance.distance
                        (App { home = "Basics", name = "Int" } [])
                        (App { home = "Basics", name = "Bool" } [])
                        |> Expect.within (Absolute 0.001) 1.0
            , test "same name different home => 0.25" <|
                \() ->
                    Distance.distance
                        (App { home = "Foo", name = "Bar" } [])
                        (App { home = "Baz", name = "Bar" } [])
                        |> Expect.within (Absolute 0.001) 0.25
            , test "unqualified name matches qualified => 0.0" <|
                \() ->
                    Distance.distance
                        (App { home = "", name = "Int" } [])
                        (App { home = "Basics", name = "Int" } [])
                        |> Expect.within (Absolute 0.001) 0.0
            , test "List a vs List a => 0.0" <|
                \() ->
                    Distance.distance
                        (App { home = "List", name = "List" } [ Var "a" ])
                        (App { home = "List", name = "List" } [ Var "b" ])
                        |> Expect.within (Absolute 0.001) 0.0
            ]
        , describe "function matching"
            [ test "a -> b vs a -> b => 0.0" <|
                \() ->
                    Distance.distance
                        (Fn [ Var "a" ] (Var "b"))
                        (Fn [ Var "c" ] (Var "d"))
                        |> Expect.within (Absolute 0.001) 0.0
            , test "Int -> String vs Int -> String => 0.0" <|
                \() ->
                    Distance.distance
                        (Fn [ App { home = "Basics", name = "Int" } [] ] (App { home = "String", name = "String" } []))
                        (Fn [ App { home = "Basics", name = "Int" } [] ] (App { home = "String", name = "String" } []))
                        |> Expect.within (Absolute 0.001) 0.0
            , test "function with permutable args" <|
                \() ->
                    -- String -> Int vs Int -> String: result Int vs String = 1.0, arg String vs Int = 1.0
                    -- avg = (1.0 + 1.0) / 2 = 1.0
                    Distance.distance
                        (Fn [ App { home = "String", name = "String" } [] ] (App { home = "Basics", name = "Int" } []))
                        (Fn [ App { home = "Basics", name = "Int" } [] ] (App { home = "String", name = "String" } []))
                        |> Expect.within (Absolute 0.001) 1.0
            ]
        , describe "tuple matching"
            [ test "same tuple => 0.0" <|
                \() ->
                    Distance.distance
                        (Tuple [ Var "a", Var "b" ])
                        (Tuple [ Var "c", Var "d" ])
                        |> Expect.within (Absolute 0.001) 0.0
            , test "unit tuples => 0.0" <|
                \() ->
                    Distance.distance (Tuple []) (Tuple [])
                        |> Expect.within (Absolute 0.001) 0.0
            ]
        , describe "record matching"
            [ test "same record => 0.0" <|
                \() ->
                    Distance.distance
                        (Record [ ( "x", Var "a" ) ] Nothing)
                        (Record [ ( "x", Var "b" ) ] Nothing)
                        |> Expect.within (Absolute 0.001) 0.0
            , test "empty records => 0.0" <|
                \() ->
                    Distance.distance (Record [] Nothing) (Record [] Nothing)
                        |> Expect.within (Absolute 0.001) 0.0
            , test "mismatched field names => 2.0" <|
                \() ->
                    -- query field x not found => 1.0, unmatched candidate field y => 1.0
                    -- total = max(1,1) = 1, sum = 2.0, result = 2.0/1 = 2.0
                    Distance.distance
                        (Record [ ( "x", Var "a" ) ] Nothing)
                        (Record [ ( "y", Var "b" ) ] Nothing)
                        |> Expect.within (Absolute 0.001) 2.0
            ]
        , describe "mismatched types"
            [ test "tuple vs app => 1.0" <|
                \() ->
                    Distance.distance
                        (Tuple [ Var "a" ])
                        (App { home = "Basics", name = "Int" } [])
                        |> Expect.within (Absolute 0.001) 1.0
            ]
        , describe "packageBoost"
            [ test "elm/core => -0.125" <|
                \() ->
                    Distance.packageBoost "elm" "core"
                        |> Expect.within (Absolute 0.001) -0.125
            , test "elm/html => -0.083" <|
                \() ->
                    Distance.packageBoost "elm" "html"
                        |> Expect.within (Absolute 0.001) -0.083
            , test "elm-community/list-extra => -0.0625" <|
                \() ->
                    Distance.packageBoost "elm-community" "list-extra"
                        |> Expect.within (Absolute 0.001) -0.0625
            , test "elm-explorations/test => -0.0625" <|
                \() ->
                    Distance.packageBoost "elm-explorations" "test"
                        |> Expect.within (Absolute 0.001) -0.0625
            , test "other package => 0" <|
                \() ->
                    Distance.packageBoost "author" "pkg"
                        |> Expect.within (Absolute 0.001) 0.0
            ]
        , describe "fn vs non-fn"
            [ test "fn query vs non-fn candidate" <|
                \() ->
                    -- a -> b vs c: wraps c as zero-arg fn, result dist = 0 (var vs var)
                    -- argPenalty = 0.5, result = 0.0 => (0.0 + 0.5) / 2 = 0.25
                    Distance.distance
                        (Fn [ Var "a" ] (Var "b"))
                        (Var "c")
                        |> Expect.within (Absolute 0.001) 0.25
            ]
        , describe "binding consistency"
            [ test "a -> a vs Int -> Int => 0.5 (both bindings consistent)" <|
                \() ->
                    -- a binds to Int (0.5), second a resolves to Int, Int vs Int = 0.0
                    -- args avg = (0.5 + 0.0) / 2 = 0.25, result = 0.0
                    -- fn = (0.25 + 0.0) / 2 = 0.125
                    Distance.distance
                        (Fn [ Var "a", Var "a" ] (App { home = "Basics", name = "Int" } []))
                        (Fn [ App { home = "Basics", name = "Int" } [], App { home = "Basics", name = "Int" } [] ] (App { home = "Basics", name = "Int" } []))
                        |> Expect.within (Absolute 0.001) 0.125
            , test "a -> a vs Int -> String penalizes inconsistency" <|
                \() ->
                    -- a binds to Int (0.5) on first arg, second a resolves to Int,
                    -- Int vs String = 1.0. Inconsistent binding is penalized.
                    -- This should score worse than Int -> Int above.
                    let
                        consistent =
                            Distance.distance
                                (Fn [ Var "a", Var "a" ] (App { home = "Basics", name = "Int" } []))
                                (Fn [ App { home = "Basics", name = "Int" } [], App { home = "Basics", name = "Int" } [] ] (App { home = "Basics", name = "Int" } []))

                        inconsistent =
                            Distance.distance
                                (Fn [ Var "a", Var "a" ] (App { home = "Basics", name = "Int" } []))
                                (Fn [ App { home = "Basics", name = "Int" } [], App { home = "String", name = "String" } [] ] (App { home = "Basics", name = "Int" } []))
                    in
                    inconsistent
                        |> Expect.greaterThan consistent
            ]
        , describe "permutation penalty"
            [ test "reordered args score worse than ordered args" <|
                \() ->
                    -- Query: Int -> String -> Bool
                    -- Candidate A: Int -> String -> Bool (same order)
                    -- Candidate B: String -> Int -> Bool (swapped args)
                    -- B should score slightly worse due to permutation penalty
                    let
                        int =
                            App { home = "Basics", name = "Int" } []

                        str =
                            App { home = "String", name = "String" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []

                        query =
                            Fn [ int, str ] bool

                        ordered =
                            Distance.distance query (Fn [ int, str ] bool)

                        reordered =
                            Distance.distance query (Fn [ str, int ] bool)
                    in
                    Expect.all
                        [ \() -> ordered |> Expect.within (Absolute 0.001) 0.0
                        , \() -> reordered |> Expect.greaterThan ordered
                        ]
                        ()
            ]
        , describe "partial application matching"
            [ test "String -> Bool vs String -> String -> Bool scores < 0.25" <|
                \() ->
                    let
                        str =
                            App { home = "String", name = "String" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []
                    in
                    Distance.distance
                        (Fn [ str ] bool)
                        (Fn [ str, str ] bool)
                        |> Expect.lessThan 0.25
            , test "exact match beats partial application" <|
                \() ->
                    let
                        str =
                            App { home = "String", name = "String" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []

                        query =
                            Fn [ str ] bool

                        exact =
                            Distance.distance query (Fn [ str ] bool)

                        partial =
                            Distance.distance query (Fn [ str, str ] bool)
                    in
                    exact |> Expect.lessThan partial
            , test "skipping 2 args costs more than skipping 1" <|
                \() ->
                    let
                        str =
                            App { home = "String", name = "String" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []

                        query =
                            Fn [ str ] bool

                        skip1 =
                            Distance.distance query (Fn [ str, str ] bool)

                        skip2 =
                            Distance.distance query (Fn [ str, str, str ] bool)
                    in
                    skip2 |> Expect.greaterThan skip1
            , test "result type mismatch penalized in partial path" <|
                \() ->
                    let
                        str =
                            App { home = "String", name = "String" } []

                        int =
                            App { home = "Basics", name = "Int" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []

                        goodResult =
                            Distance.distance (Fn [ str ] bool) (Fn [ str, str ] bool)

                        badResult =
                            Distance.distance (Fn [ str ] bool) (Fn [ str, str ] int)
                    in
                    badResult |> Expect.greaterThan goodResult
            , test "trailing mismatch: permutation path wins" <|
                \() ->
                    let
                        int =
                            App { home = "Basics", name = "Int" } []

                        str =
                            App { home = "String", name = "String" } []

                        bool =
                            App { home = "Basics", name = "Bool" } []
                    in
                    -- Query: Int -> Bool, Candidate: Int -> String -> Bool
                    -- Trailing: String vs Int = bad, but permutation can pick Int
                    Distance.distance
                        (Fn [ int ] bool)
                        (Fn [ int, str ] bool)
                        |> Expect.lessThan 0.5
            , test "multi-arg partial: a -> b -> c vs x -> a -> b -> c scores < 0.5" <|
                \() ->
                    Distance.distance
                        (Fn [ Var "a", Var "b" ] (Var "c"))
                        (Fn [ Var "x", Var "a", Var "b" ] (Var "c"))
                        |> Expect.lessThan 0.5
            ]
        , describe "substring name matching"
            [ test "substring match => name distance 0.5" <|
                \() ->
                    -- Int vs Integer: "Int" is substring of "Integer"
                    -- nameDistance = 0.5, no args => 0.5
                    Distance.distance
                        (App { home = "", name = "Int" } [])
                        (App { home = "", name = "Integer" } [])
                        |> Expect.within (Absolute 0.001) 0.5
            ]
        ]
