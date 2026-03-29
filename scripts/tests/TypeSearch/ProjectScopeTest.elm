module TypeSearch.ProjectScopeTest exposing (suite)

import Expect exposing (FloatingPointTolerance(..))
import Test exposing (Test, describe, test)
import TypeSearch.Distance as Distance
import TypeSearch.Search as Search exposing (Candidate, SearchResult)
import TypeSearch.Type exposing (Type(..))


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
    describe "TypeSearch project scope"
        [ test "empty local + non-empty global candidates gives global results only" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    allCandidates : List Candidate
                    allCandidates =
                        [ mkCandidate "List" "map" "value" (Fn [ Var "a" ] (Var "b")) "F1:" "elm" "core" ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 0.25 } query "F1:" allCandidates
                in
                List.map .package results
                    |> Expect.equal [ "elm/core" ]
        , test "non-empty local + empty global candidates gives local results only" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    allCandidates : List Candidate
                    allCandidates =
                        [ mkCandidate "MyModule" "myFn" "value" (Fn [ Var "a" ] (Var "b")) "F1:" "local" "myapp" ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 0.25 } query "F1:" allCandidates
                in
                List.map .package results
                    |> Expect.equal [ "local/myapp" ]
        , test "local candidate with org=local gets packageBoost of -0.25" <|
            \() ->
                Distance.packageBoost "local" "myapp"
                    |> Expect.within (Absolute 0.001) -0.25
        , test "local module ranks before elm/core on equal type distance" <|
            \() ->
                let
                    query : Type
                    query =
                        Fn [ Var "a" ] (Var "b")

                    candidates : List Candidate
                    candidates =
                        [ mkCandidate "M" "coreFunc" "value" (Fn [ Var "a" ] (Var "b")) "F1:" "elm" "core"
                        , mkCandidate "M" "localFunc" "value" (Fn [ Var "a" ] (Var "b")) "F1:" "local" "myapp"
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 20, threshold = 1.0 } query "F1:" candidates
                in
                List.map .name results
                    |> Expect.equal [ "localFunc", "coreFunc" ]
        , test "limit is applied after merging local and global candidates" <|
            \() ->
                let
                    query : Type
                    query =
                        Var "a"

                    globalCandidates : List Candidate
                    globalCandidates =
                        List.range 1 5
                            |> List.map
                                (\i ->
                                    mkCandidate "M"
                                        ("g" ++ String.fromInt i)
                                        "value"
                                        (Var "b")
                                        "F0:"
                                        "elm"
                                        "core"
                                )

                    localCandidates : List Candidate
                    localCandidates =
                        List.range 1 5
                            |> List.map
                                (\i ->
                                    mkCandidate "M"
                                        ("l" ++ String.fromInt i)
                                        "value"
                                        (Var "b")
                                        "F0:"
                                        "local"
                                        "myapp"
                                )

                    results : List SearchResult
                    results =
                        Search.search { limit = 3, threshold = 1.0 } query "F0:" (globalCandidates ++ localCandidates)
                in
                List.length results |> Expect.equal 3
        , test "packageBoost local ignores package name" <|
            \() ->
                Distance.packageBoost "local" "anything"
                    |> Expect.within (Absolute 0.001) -0.25
        ]
