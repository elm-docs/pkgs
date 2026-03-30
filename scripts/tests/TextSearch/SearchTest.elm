module TextSearch.SearchTest exposing (suite)

import Expect
import Test exposing (Test, describe, test)
import TextSearch.Rank exposing (RawCandidate)
import TextSearch.Search as Search exposing (SearchResult)


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
    describe "TextSearch.Search"
        [ test "results sorted by score ascending (best first)" <|
            \() ->
                let
                    candidates : List RawCandidate
                    candidates =
                        [ mkCandidate "a/worst" -1.0 0 1 False
                        , mkCandidate "a/best" -10.0 100 5 True
                        , mkCandidate "a/mid" -5.0 10 2 False
                        ]

                    results : List SearchResult
                    results =
                        Search.search { limit = 10 } candidates
                in
                List.map .package results
                    |> Expect.equal [ "a/best", "a/mid", "a/worst" ]
        , test "limit is respected" <|
            \() ->
                let
                    candidates : List RawCandidate
                    candidates =
                        List.range 1 10
                            |> List.map (\i -> mkCandidate ("a/pkg" ++ String.fromInt i) (toFloat -i) 0 1 False)

                    results : List SearchResult
                    results =
                        Search.search { limit = 3 } candidates
                in
                List.length results
                    |> Expect.equal 3
        , test "empty candidates → empty results" <|
            \() ->
                Search.search { limit = 10 } []
                    |> Expect.equal []
        ]
