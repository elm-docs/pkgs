module TextSearch.Rank exposing (RawCandidate, ScoredPackage, Weights, defaultWeights, scorePackage)


type alias Weights =
    { starsBoost : Float
    , summaryMatchBoost : Float
    , matchCountBoost : Float
    }


type alias RawCandidate =
    { package : String
    , summary : String
    , textScore : Float
    , matchCount : Int
    , stars : Int
    , summaryMatch : Bool
    }


type alias ScoredPackage =
    { package : String
    , summary : String
    , score : Float
    , stars : Int
    }


defaultWeights : Weights
defaultWeights =
    { starsBoost = 0.5
    , summaryMatchBoost = -3.0
    , matchCountBoost = 0.3
    }


scorePackage : Weights -> RawCandidate -> ScoredPackage
scorePackage weights candidate =
    let
        starsComponent : Float
        starsComponent =
            weights.starsBoost * logBase 10 (toFloat (candidate.stars + 1))

        summaryComponent : Float
        summaryComponent =
            if candidate.summaryMatch then
                weights.summaryMatchBoost

            else
                0.0

        matchCountComponent : Float
        matchCountComponent =
            weights.matchCountBoost * logBase 10 (toFloat (max candidate.matchCount 1))

        score : Float
        score =
            candidate.textScore
                - starsComponent
                + summaryComponent
                - matchCountComponent
    in
    { package = candidate.package
    , summary = candidate.summary
    , score = score
    , stars = candidate.stars
    }
