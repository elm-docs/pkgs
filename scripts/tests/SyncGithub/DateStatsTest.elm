module SyncGithub.DateStatsTest exposing (suite)

import Expect
import SyncGithub.DateStats as DateStats exposing (DateStats, IssueInfo)
import Test exposing (Test, describe, test)
import Time


-- Reference time: 2024-01-10T00:00:00Z = 1704844800000 ms
referenceTime : Time.Posix
referenceTime =
    Time.millisToPosix 1704844800000


issueAt : String -> IssueInfo
issueAt createdAt =
    { number = 1
    , createdAt = createdAt
    , lastCommentAt = Nothing
    , lastCommentByMaintainer = Nothing
    }


suite : Test
suite =
    describe "DateStats"
        [ describe "daysSince"
            [ test "0 days for same timestamp" <|
                \() ->
                    DateStats.daysSince referenceTime "2024-01-10T00:00:00Z"
                        |> Expect.equal 0
            , test "1 day earlier" <|
                \() ->
                    DateStats.daysSince referenceTime "2024-01-09T00:00:00Z"
                        |> Expect.equal 1
            , test "10 days earlier" <|
                \() ->
                    DateStats.daysSince referenceTime "2023-12-31T00:00:00Z"
                        |> Expect.equal 10
            , test "returns 0 for unparseable date" <|
                \() ->
                    DateStats.daysSince referenceTime "not-a-date"
                        |> Expect.equal 0
            ]
        , describe "computeDateStats"
            [ test "empty list returns all zeros" <|
                \() ->
                    DateStats.computeDateStats referenceTime []
                        |> Expect.equal { count = 0, minDays = 0, maxDays = 0, avgDays = 0, items = [] }
            , test "single item: min = max = avg" <|
                \() ->
                    let
                        items : List IssueInfo
                        items =
                            [ issueAt "2024-01-09T00:00:00Z" ]

                        stats : DateStats
                        stats =
                            DateStats.computeDateStats referenceTime items
                    in
                    Expect.all
                        [ \s -> Expect.equal 1 s.count
                        , \s -> Expect.equal 1 s.minDays
                        , \s -> Expect.equal 1 s.maxDays
                        , \s -> Expect.equal 1 s.avgDays
                        ]
                        stats
            , test "multiple items: correct min/max/avg" <|
                \() ->
                    let
                        items : List IssueInfo
                        items =
                            [ issueAt "2024-01-09T00:00:00Z" -- 1 day
                            , issueAt "2024-01-07T00:00:00Z" -- 3 days
                            , issueAt "2024-01-05T00:00:00Z" -- 5 days
                            ]

                        stats : DateStats
                        stats =
                            DateStats.computeDateStats referenceTime items
                    in
                    Expect.all
                        [ \s -> Expect.equal 3 s.count
                        , \s -> Expect.equal 1 s.minDays
                        , \s -> Expect.equal 5 s.maxDays
                        , \s -> Expect.equal 3 s.avgDays
                        ]
                        stats
            , test "preserves items list" <|
                \() ->
                    let
                        items : List IssueInfo
                        items =
                            [ issueAt "2024-01-09T00:00:00Z" ]
                    in
                    DateStats.computeDateStats referenceTime items
                        |> .items
                        |> Expect.equal items
            ]
        ]
