module TextSearch.SearchTest exposing (suite)

import Expect
import Test exposing (Test, describe, test)
import TextSearch.Search as Search exposing (SearchResult)


mkResult : String -> Float -> Int -> SearchResult
mkResult package rank stars =
    { package = package
    , summary = "A summary"
    , rank = rank
    , stars = stars
    }


suite : Test
suite =
    describe "TextSearch.Search"
        [ test "limit is respected" <|
            \() ->
                let
                    results : List SearchResult
                    results =
                        List.range 1 10
                            |> List.map (\i -> mkResult ("a/pkg" ++ String.fromInt i) (toFloat i) 0)

                    limited : List SearchResult
                    limited =
                        Search.search { limit = 3 } results
                in
                List.length limited
                    |> Expect.equal 3
        , test "empty input returns empty list" <|
            \() ->
                Search.search { limit = 10 } []
                    |> Expect.equal []
        , test "result structure preserved" <|
            \() ->
                let
                    input : List SearchResult
                    input =
                        [ { package = "elm/json"
                          , summary = "JSON encoding/decoding"
                          , rank = 85.5
                          , stars = 200
                          }
                        ]

                    output : List SearchResult
                    output =
                        Search.search { limit = 10 } input
                in
                case output of
                    [ r ] ->
                        Expect.all
                            [ \_ -> Expect.equal "elm/json" r.package
                            , \_ -> Expect.equal "JSON encoding/decoding" r.summary
                            , \_ -> Expect.within (Expect.Absolute 0.01) 85.5 r.rank
                            , \_ -> Expect.equal 200 r.stars
                            ]
                            ()

                    _ ->
                        Expect.fail "Expected exactly one result"
        ]
