module TypeSearch.Fingerprint exposing (countArgs, fingerprint, fingerprintCompatible)

import TypeSearch.Type exposing (Type(..))


fingerprint : Type -> String
fingerprint tipe =
    let
        args : Int
        args =
            countArgs tipe

        concretes : List String
        concretes =
            collectConcretes tipe [] |> List.sort
    in
    "F" ++ String.fromInt args ++ ":" ++ String.join "," concretes


countArgs : Type -> Int
countArgs tipe =
    case tipe of
        Fn args _ ->
            List.length args

        _ ->
            0


collectConcretes : Type -> List String -> List String
collectConcretes tipe acc =
    case tipe of
        Var _ ->
            acc

        Fn args result ->
            let
                afterArgs : List String
                afterArgs =
                    List.foldl (\arg a -> collectConcretes arg a) acc args
            in
            collectConcretes result afterArgs

        App qname args ->
            let
                withName : List String
                withName =
                    acc ++ [ qname.name ]
            in
            List.foldl (\arg a -> collectConcretes arg a) withName args

        Tuple args ->
            List.foldl (\arg a -> collectConcretes arg a) acc args

        Record fields _ ->
            List.foldl (\( _, ft ) a -> collectConcretes ft a) acc fields


fingerprintCompatible : String -> String -> Bool
fingerprintCompatible queryFp candidateFp =
    let
        q : ParsedFp
        q =
            parseFp queryFp

        c : ParsedFp
        c =
            parseFp candidateFp
    in
    if abs (q.argCount - c.argCount) > 1 then
        False

    else if not (List.isEmpty q.concretes) && not (List.isEmpty c.concretes) then
        hasOverlap q.concretes c.concretes

    else
        True


type alias ParsedFp =
    { argCount : Int, concretes : List String }


parseFp : String -> ParsedFp
parseFp fp =
    let
        colonIdx : Int
        colonIdx =
            String.indexes ":" fp |> List.head |> Maybe.withDefault 0

        argCountStr : String
        argCountStr =
            String.slice 1 colonIdx fp

        argCount : Int
        argCount =
            String.toInt argCountStr |> Maybe.withDefault 0

        rest : String
        rest =
            String.dropLeft (colonIdx + 1) fp

        concretes : List String
        concretes =
            if rest == "" then
                []

            else
                String.split "," rest
    in
    { argCount = argCount, concretes = concretes }


hasOverlap : List String -> List String -> Bool
hasOverlap listA listB =
    List.any (\a -> List.member a listB) listA
