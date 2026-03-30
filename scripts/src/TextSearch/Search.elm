module TextSearch.Search exposing (SearchResult, search)

import TextSearch.Rank as Rank exposing (RawCandidate, ScoredPackage)


type alias SearchResult =
    { package : String
    , summary : String
    , score : Float
    , stars : Int
    }


search : { limit : Int } -> List RawCandidate -> List SearchResult
search config candidates =
    candidates
        |> List.map (Rank.scorePackage Rank.defaultWeights)
        |> List.sortBy .score
        |> List.take config.limit
        |> List.map toResult


toResult : ScoredPackage -> SearchResult
toResult scored =
    { package = scored.package
    , summary = scored.summary
    , score = scored.score
    , stars = scored.stars
    }
