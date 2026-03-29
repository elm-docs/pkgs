module TypeSearch.SearchTest exposing (suite)

import Expect exposing (FloatingPointTolerance(..))
import Test exposing (Test, describe, test)
import TypeSearch.Search as Search exposing (Candidate, SearchResult)
import TypeSearch.Type exposing (Type(..))


defaultConfig : { limit : Int, threshold : Float }
defaultConfig =
    { limit = 20, threshold = 0.125 }


mkCandidate : String -> String -> String -> Type -> String -> String -> String -> Candidate
mkCandidate modName name kind typeAst fp org pkgName =
    { moduleName = modName
    , name = name
    , kind = kind
    , typeRaw = ""
    , typeAst = typeAst
    , fingerprint = fp
    , org = org
    , pkgName = pkgName
    }


suite : Test
suite =
    describe "Search"
        [ test "exact match appears in results" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "List"
                            "map"
                            "value"
                            (Fn [ Var "a" ] (Var "b"))
                            "F1:"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search defaultConfig query "F1:" candidates
                in
                List.length results
                    |> Expect.equal 1
        , test "exact match has distance near 0 with boost" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "List"
                            "map"
                            "value"
                            (Fn [ Var "a" ] (Var "b"))
                            "F1:"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search defaultConfig query "F1:" candidates
                in
                case results of
                    [ r ] ->
                        r.distance
                            |> Expect.within (Absolute 0.001) -0.125

                    _ ->
                        Expect.fail "Expected exactly one result"
        , test "filters by fingerprint compatibility" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ App { home = "Basics", name = "Int" } [] ] (App { home = "String", name = "String" } [])

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "String"
                            "fromInt"
                            "value"
                            (Fn [ App { home = "Basics", name = "Int" } [] ] (App { home = "String", name = "String" } []))
                            "F1:Int,String"
                            "elm"
                            "core"
                        , mkCandidate "Other"
                            "nope"
                            "value"
                            (Fn [ Var "a", Var "b", Var "c" ] (Var "d"))
                            "F3:"
                            "author"
                            "pkg"
                        ]

                    results : List SearchResult
                    results =
                        Search.search defaultConfig query "F1:Int,String" candidates
                in
                List.length results
                    |> Expect.equal 1
        , test "respects threshold" <|
            \() ->
                let
                    query : Type
                    query =
                        App { home = "Basics", name = "Int" } []

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "Basics"
                            "toFloat"
                            "value"
                            (App { home = "Basics", name = "Bool" } [])
                            "F0:Bool"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 0.5 } query "F0:Int" candidates
                in
                -- Bool vs Int = 1.0 distance, exceeds 0.5 threshold even with -0.125 boost
                List.length results
                    |> Expect.equal 0
        , test "respects limit" <|
            \() ->
                let
                    query : Type
                    query =
                        Var "a"

                    candidates : List Candidate
                    candidates =
                        List.range 1 10
                            |> List.map
                                (\i ->
                                    mkCandidate "M"
                                        ("f" ++ String.fromInt i)
                                        "value"
                                        (Var "b")
                                        "F0:"
                                        "elm"
                                        "core"
                                )

                    results : List SearchResult
                    results =
                        Search.search { limit = 3, threshold = 1.0 } query "F0:" candidates
                in
                List.length results
                    |> Expect.equal 3
        , test "sorts by distance ascending" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (App { home = "Basics", name = "Int" } [])

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "M"
                            "far"
                            "value"
                            (Fn [ Var "a" ] (Var "b"))
                            "F1:"
                            "author"
                            "pkg"
                        , mkCandidate "M"
                            "exact"
                            "value"
                            (Fn [ Var "a" ] (App { home = "Basics", name = "Int" } []))
                            "F1:Int"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 2.0 } query "F1:Int" candidates
                in
                List.map .name results
                    |> Expect.equal [ "exact", "far" ]
        , test "package boost affects ranking" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "M"
                            "third_party"
                            "value"
                            (Fn [ Var "a" ] (Var "b"))
                            "F1:"
                            "author"
                            "pkg"
                        , mkCandidate "M"
                            "core_fn"
                            "value"
                            (Fn [ Var "a" ] (Var "b"))
                            "F1:"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 1.0 } query "F1:" candidates
                in
                List.map .name results
                    |> Expect.equal [ "core_fn", "third_party" ]
        , test "result includes package name" <|
            \() ->
                let
                    query : Type
                    query =
                        Var "a"

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "List"
                            "head"
                            "value"
                            (Var "b")
                            "F0:"
                            "elm"
                            "core"
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 1.0 } query "F0:" candidates
                in
                case results of
                    [ r ] ->
                        r.package
                            |> Expect.equal "elm/core"

                    _ ->
                        Expect.fail "Expected one result"
        ]
