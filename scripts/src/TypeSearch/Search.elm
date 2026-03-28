module TypeSearch.Search exposing (Candidate, SearchResult, search)

import TypeSearch.Distance as Distance
import TypeSearch.Fingerprint as Fingerprint
import TypeSearch.Type exposing (Type)


type alias Candidate =
    { moduleName : String
    , name : String
    , kind : String
    , typeRaw : String
    , typeAst : Type
    , fingerprint : String
    , org : String
    , pkgName : String
    }


type alias SearchResult =
    { package : String
    , moduleName : String
    , name : String
    , kind : String
    , typeRaw : String
    , distance : Float
    }


search : { limit : Int, threshold : Float } -> Type -> String -> List Candidate -> List SearchResult
search config queryAst queryFp candidates =
    candidates
        |> List.filterMap
            (\c ->
                if not (Fingerprint.fingerprintCompatible queryFp c.fingerprint) then
                    Nothing

                else
                    let
                        dist =
                            Distance.distance queryAst c.typeAst
                                + Distance.packageBoost c.org c.pkgName
                    in
                    if dist <= config.threshold then
                        Just
                            { package = c.org ++ "/" ++ c.pkgName
                            , moduleName = c.moduleName
                            , name = c.name
                            , kind = c.kind
                            , typeRaw = c.typeRaw
                            , distance = dist
                            }

                    else
                        Nothing
            )
        |> List.sortBy .distance
        |> List.take config.limit
