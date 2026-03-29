module Shared.ReportTest exposing (suite)

import Expect
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)
import Shared.Report as Report
import Status.Classification exposing (Summary)
import Test exposing (Test, describe, test)


makePv : String -> PackageVersion
makePv s =
    case PackageVersion.fromString s of
        Just pv ->
            pv

        Nothing ->
            makePv "test/test@0.0.0"


suite : Test
suite =
    describe "Report"
        [ describe "formatPercent"
            [ test "3 out of 10 is 30.0%" <|
                \() ->
                    Report.formatPercent 3 10
                        |> Expect.equal "30.0%"
            , test "0 out of 0 is 0.0%" <|
                \() ->
                    Report.formatPercent 0 0
                        |> Expect.equal "0.0%"
            , test "1 out of 3 is 33.3%" <|
                \() ->
                    Report.formatPercent 1 3
                        |> Expect.equal "33.3%"
            , test "10 out of 10 is 100.0%" <|
                \() ->
                    Report.formatPercent 10 10
                        |> Expect.equal "100.0%"
            ]
        , describe "formatSummary"
            [ test "contains all counts with correct values" <|
                \() ->
                    let
                        summary : Summary
                        summary =
                            { total = 100
                            , success = 80
                            , failure = 5
                            , pending = 3
                            , missing = 12
                            }

                        result : String
                        result =
                            Report.formatSummary summary
                    in
                    Expect.all
                        [ \_ -> String.contains "100" result |> Expect.equal True
                        , \_ -> String.contains "80" result |> Expect.equal True
                        , \_ -> String.contains "5" result |> Expect.equal True
                        , \_ -> String.contains "3" result |> Expect.equal True
                        , \_ -> String.contains "12" result |> Expect.equal True
                        , \_ -> String.contains "80.0%" result |> Expect.equal True
                        , \_ -> String.contains "Package Sync Status" result |> Expect.equal True
                        ]
                        ()
            , test "shows correct percentage for different values" <|
                \() ->
                    let
                        summary : Summary
                        summary =
                            { total = 200
                            , success = 150
                            , failure = 20
                            , pending = 10
                            , missing = 20
                            }

                        result : String
                        result =
                            Report.formatSummary summary
                    in
                    Expect.all
                        [ \_ -> String.contains "150" result |> Expect.equal True
                        , \_ -> String.contains "75.0%" result |> Expect.equal True
                        ]
                        ()
            , test "synced line shows success count not failure count" <|
                \() ->
                    let
                        summary : Summary
                        summary =
                            { total = 10
                            , success = 7
                            , failure = 2
                            , pending = 0
                            , missing = 1
                            }

                        result : String
                        result =
                            Report.formatSummary summary

                        lines : List String
                        lines =
                            String.lines result

                        syncedLine : String
                        syncedLine =
                            lines
                                |> List.filter (\l -> String.contains "Synced" l)
                                |> List.head
                                |> Maybe.withDefault ""
                    in
                    Expect.all
                        [ \_ -> String.contains "7" syncedLine |> Expect.equal True
                        , \_ -> String.contains "70.0%" result |> Expect.equal True
                        ]
                        ()
            ]
        , describe "formatDetailList"
            [ test "empty list returns empty string" <|
                \() ->
                    Report.formatDetailList "Title" identity []
                        |> Expect.equal ""
            , test "includes title in output" <|
                \() ->
                    let
                        packages : List PackageVersion
                        packages =
                            [ makePv "elm/core@1.0.5" ]

                        result : String
                        result =
                            Report.formatDetailList "My Title" identity packages
                    in
                    String.contains "My Title" result
                        |> Expect.equal True
            , test "3 items contains all 3 labels" <|
                \() ->
                    let
                        packages : List PackageVersion
                        packages =
                            List.map makePv
                                [ "elm/core@1.0.5"
                                , "elm/json@1.1.3"
                                , "elm/html@1.0.0"
                                ]

                        result : String
                        result =
                            Report.formatDetailList "Title" identity packages
                    in
                    Expect.all
                        [ \_ -> String.contains "elm/core@1.0.5" result |> Expect.equal True
                        , \_ -> String.contains "elm/json@1.1.3" result |> Expect.equal True
                        , \_ -> String.contains "elm/html@1.0.0" result |> Expect.equal True
                        ]
                        ()
            , test "7 items shows 5 and mentions 2 more" <|
                \() ->
                    let
                        packages : List PackageVersion
                        packages =
                            List.map makePv
                                [ "a/a@1.0.0"
                                , "b/b@1.0.0"
                                , "c/c@1.0.0"
                                , "d/d@1.0.0"
                                , "e/e@1.0.0"
                                , "f/f@1.0.0"
                                , "g/g@1.0.0"
                                ]

                        result : String
                        result =
                            Report.formatDetailList "Title" identity packages
                    in
                    Expect.all
                        [ \_ -> String.contains "a/a@1.0.0" result |> Expect.equal True
                        , \_ -> String.contains "e/e@1.0.0" result |> Expect.equal True
                        , \_ -> String.contains "f/f@1.0.0" result |> Expect.equal False
                        , \_ -> String.contains "2 more" result |> Expect.equal True
                        ]
                        ()
            ]
        ]
