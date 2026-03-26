module Status.ClassificationTest exposing (suite)

import Expect
import Set
import Shared.PackageVersion as PackageVersion
import Status.Classification as Classification exposing (Status(..))
import Test exposing (Test, describe, test)


emptyIndex : Classification.FileIndex
emptyIndex =
    { docsFiles = Set.empty
    , errorsFiles = Set.empty
    , pendingFiles = Set.empty
    }


suite : Test
suite =
    describe "Classification"
        [ describe "classify"
            [ test "pending takes priority over docs" <|
                \() ->
                    let
                        index =
                            { emptyIndex
                                | docsFiles = Set.singleton "elm/core@1.0.5"
                                , pendingFiles = Set.singleton "elm/core@1.0.5"
                            }
                    in
                    Classification.classify index "elm/core@1.0.5"
                        |> Expect.equal Pending
            , test "pending takes priority over errors" <|
                \() ->
                    let
                        index =
                            { emptyIndex
                                | errorsFiles = Set.singleton "elm/core@1.0.5"
                                , pendingFiles = Set.singleton "elm/core@1.0.5"
                            }
                    in
                    Classification.classify index "elm/core@1.0.5"
                        |> Expect.equal Pending
            , test "errors takes priority over docs" <|
                \() ->
                    let
                        index =
                            { emptyIndex
                                | docsFiles = Set.singleton "elm/core@1.0.5"
                                , errorsFiles = Set.singleton "elm/core@1.0.5"
                            }
                    in
                    Classification.classify index "elm/core@1.0.5"
                        |> Expect.equal Failure
            , test "success when only in docs" <|
                \() ->
                    let
                        index =
                            { emptyIndex | docsFiles = Set.singleton "elm/core@1.0.5" }
                    in
                    Classification.classify index "elm/core@1.0.5"
                        |> Expect.equal Success
            , test "missing when in no sets" <|
                \() ->
                    Classification.classify emptyIndex "elm/core@1.0.5"
                        |> Expect.equal Missing
            ]
        , describe "classifyAll"
            [ test "places packages in correct buckets" <|
                \() ->
                    let
                        index =
                            { docsFiles = Set.fromList [ "elm/core@1.0.5", "elm/json@1.1.3" ]
                            , errorsFiles = Set.singleton "elm/json@1.1.3"
                            , pendingFiles = Set.singleton "elm/html@1.0.0"
                            }

                        packages =
                            List.filterMap PackageVersion.fromString
                                [ "elm/core@1.0.5"
                                , "elm/json@1.1.3"
                                , "elm/html@1.0.0"
                                , "elm/url@1.0.0"
                                ]

                        result =
                            Classification.classifyAll index packages

                        toKeys =
                            List.map PackageVersion.toKey
                    in
                    Expect.all
                        [ \_ -> Expect.equal [ "elm/core@1.0.5" ] (toKeys result.success)
                        , \_ -> Expect.equal [ "elm/json@1.1.3" ] (toKeys result.failure)
                        , \_ -> Expect.equal [ "elm/html@1.0.0" ] (toKeys result.pending)
                        , \_ -> Expect.equal [ "elm/url@1.0.0" ] (toKeys result.missing)
                        ]
                        ()
            ]
        , describe "summarize"
            [ test "counts correctly for empty list" <|
                \() ->
                    let
                        result =
                            Classification.classifyAll emptyIndex []

                        summary =
                            Classification.summarize result
                    in
                    Expect.all
                        [ \_ -> Expect.equal 0 summary.total
                        , \_ -> Expect.equal 0 summary.success
                        , \_ -> Expect.equal 0 summary.failure
                        , \_ -> Expect.equal 0 summary.pending
                        , \_ -> Expect.equal 0 summary.missing
                        ]
                        ()
            , test "counts correctly for mixed list" <|
                \() ->
                    let
                        index =
                            { docsFiles = Set.fromList [ "a/b@1.0.0", "c/d@1.0.0" ]
                            , errorsFiles = Set.singleton "c/d@1.0.0"
                            , pendingFiles = Set.singleton "e/f@1.0.0"
                            }

                        packages =
                            List.filterMap PackageVersion.fromString
                                [ "a/b@1.0.0"
                                , "c/d@1.0.0"
                                , "e/f@1.0.0"
                                , "g/h@1.0.0"
                                ]

                        summary =
                            Classification.classifyAll index packages
                                |> Classification.summarize
                    in
                    Expect.all
                        [ \_ -> Expect.equal 4 summary.total
                        , \_ -> Expect.equal 1 summary.success
                        , \_ -> Expect.equal 1 summary.failure
                        , \_ -> Expect.equal 1 summary.pending
                        , \_ -> Expect.equal 1 summary.missing
                        ]
                        ()
            ]
        ]
