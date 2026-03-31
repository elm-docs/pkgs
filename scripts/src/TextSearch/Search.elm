module TextSearch.Search exposing (SearchResult, search)

{-| Thin pass-through for text search results. SQL handles filtering
and sorting; this module enforces the result limit as a safety measure.
-}

type alias SearchResult =
    { package : String
    , summary : String
    , rank : Float
    , stars : Int
    }


search : { limit : Int } -> List SearchResult -> List SearchResult
search config results =
    List.take config.limit results
