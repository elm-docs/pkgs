module TypeSearch.Normalize exposing (normalize)

{-| Canonical renaming of type variables (a, b, c, ...) for consistent comparison.
-}

import Dict exposing (Dict)
import Set exposing (Set)
import TypeSearch.Type exposing (Type(..))


reservedVars : Set String
reservedVars =
    Set.fromList [ "number", "comparable", "appendable", "compappend" ]


normalize : Type -> Type
normalize tipe =
    let
        seen : List String
        seen =
            collectVars tipe []

        mapping : Dict String String
        mapping =
            buildMapping seen 0 Dict.empty
    in
    renameVars mapping tipe



-- COLLECT VARS in order of first appearance


collectVars : Type -> List String -> List String
collectVars tipe seen =
    case tipe of
        Var name ->
            if List.member name seen then
                seen

            else
                seen ++ [ name ]

        Fn args result ->
            let
                afterArgs : List String
                afterArgs =
                    List.foldl (\arg acc -> collectVars arg acc) seen args
            in
            collectVars result afterArgs

        App _ args ->
            List.foldl (\arg acc -> collectVars arg acc) seen args

        Tuple args ->
            List.foldl (\arg acc -> collectVars arg acc) seen args

        Record fields ext ->
            let
                afterExt : List String
                afterExt =
                    case ext of
                        Just name ->
                            if List.member name seen then
                                seen

                            else
                                seen ++ [ name ]

                        Nothing ->
                            seen
            in
            List.foldl (\( _, ft ) acc -> collectVars ft acc) afterExt fields



-- BUILD MAPPING


buildMapping : List String -> Int -> Dict String String -> Dict String String
buildMapping vars nextIdx mapping =
    case vars of
        [] ->
            mapping

        name :: rest ->
            if Dict.member name mapping then
                buildMapping rest nextIdx mapping

            else if Set.member name reservedVars then
                buildMapping rest nextIdx (Dict.insert name name mapping)

            else
                let
                    ( canonical, newIdx ) =
                        nextCanonical nextIdx
                in
                buildMapping rest newIdx (Dict.insert name canonical mapping)


nextCanonical : Int -> ( String, Int )
nextCanonical idx =
    let
        candidate : String
        candidate =
            canonicalName idx
    in
    if Set.member candidate reservedVars then
        nextCanonical (idx + 1)

    else
        ( candidate, idx + 1 )


canonicalName : Int -> String
canonicalName idx =
    let
        letters : String
        letters =
            "abcdefghijklmnopqrstuvwxyz"

        letterIdx : Int
        letterIdx =
            modBy 26 idx

        letter : String
        letter =
            String.slice letterIdx (letterIdx + 1) letters
    in
    if idx < 26 then
        letter

    else
        letter ++ String.fromInt (idx // 26)



-- RENAME VARS


renameVars : Dict String String -> Type -> Type
renameVars mapping tipe =
    case tipe of
        Var name ->
            Var (Dict.get name mapping |> Maybe.withDefault name)

        Fn args result ->
            Fn
                (List.map (renameVars mapping) args)
                (renameVars mapping result)

        App qname args ->
            App qname (List.map (renameVars mapping) args)

        Tuple args ->
            Tuple (List.map (renameVars mapping) args)

        Record fields ext ->
            Record
                (List.map (\( n, t ) -> ( n, renameVars mapping t )) fields)
                (Maybe.map (\e -> Dict.get e mapping |> Maybe.withDefault e) ext)
