module TextSearch.RankTest exposing (suite)

import Expect exposing (FloatingPointTolerance(..))
import Test exposing (Test, describe, test)
import TextSearch.Rank as Rank exposing (RawCandidate, ScoredPackage, Weights)


mkCandidate : String -> Float -> Int -> Int -> Bool -> RawCandidate
mkCandidate package textScore stars matchCount summaryMatch =
    { package = package
    , summary = "A summary"
    , textScore = textScore
    , matchCount = matchCount
    , stars = stars
    , summaryMatch = summaryMatch
    }


suite : Test
suite =
    describe "TextSearch.Rank"
        [ test "higher stars → lower (better) score" <|
            \() ->
                let
                    low : ScoredPackage
                    low =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/low" -5.0 10 1 False)

                    high : ScoredPackage
                    high =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/high" -5.0 1000 1 False)
                in
                high.score
                    |> Expect.lessThan low.score
        , test "summary match → lower (better) score" <|
            \() ->
                let
                    noMatch : ScoredPackage
                    noMatch =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -5.0 10 1 False)

                    withMatch : ScoredPackage
                    withMatch =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -5.0 10 1 True)
                in
                withMatch.score
                    |> Expect.lessThan noMatch.score
        , test "more negative textScore → lower (better) score" <|
            \() ->
                let
                    shallow : ScoredPackage
                    shallow =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -2.0 10 1 False)

                    deep : ScoredPackage
                    deep =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -8.0 10 1 False)
                in
                deep.score
                    |> Expect.lessThan shallow.score
        , test "higher matchCount → lower (better) score" <|
            \() ->
                let
                    few : ScoredPackage
                    few =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -5.0 10 1 False)

                    many : ScoredPackage
                    many =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -5.0 10 100 False)
                in
                many.score
                    |> Expect.lessThan few.score
        , test "zero stars doesn't crash" <|
            \() ->
                let
                    result : ScoredPackage
                    result =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" -5.0 0 1 False)
                in
                -- log10(0+1) = 0, so starsBoost contributes nothing
                result.score
                    |> Expect.within (Absolute 0.001) -5.0
        , test "package name is preserved through scoring" <|
            \() ->
                let
                    result : ScoredPackage
                    result =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "elm/json" -5.0 100 1 False)
                in
                result.package
                    |> Expect.equal "elm/json"
        , test "custom weights change behavior — zero weights → only textScore matters" <|
            \() ->
                let
                    zeroWeights : Weights
                    zeroWeights =
                        { starsBoost = 0.0, summaryMatchBoost = 0.0, matchCountBoost = 0.0 }

                    result : ScoredPackage
                    result =
                        Rank.scorePackage zeroWeights (mkCandidate "a/pkg" -5.0 1000 100 True)
                in
                result.score
                    |> Expect.within (Absolute 0.001) -5.0
        , test "summary-only match still gets a negative score" <|
            \() ->
                let
                    result : ScoredPackage
                    result =
                        Rank.scorePackage Rank.defaultWeights (mkCandidate "a/pkg" 0.0 0 0 True)
                in
                result.score
                    |> Expect.lessThan 0.0
        ]
