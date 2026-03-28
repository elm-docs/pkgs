module TypeSearch.Distance exposing (distance, packageBoost)

import Dict exposing (Dict)
import Set exposing (Set)
import TypeSearch.Type exposing (QualifiedName, Type(..))


noPenalty : Float
noPenalty =
    0.0


lowPenalty : Float
lowPenalty =
    0.25


mediumPenalty : Float
mediumPenalty =
    0.5


maxPenalty : Float
maxPenalty =
    1.0


maxPermutationArgs : Int
maxPermutationArgs =
    6


permutationPenalty : Float
permutationPenalty =
    0.05


reservedMatches : Dict String (Set String)
reservedMatches =
    Dict.fromList
        [ ( "number", Set.fromList [ "Float", "Int" ] )
        , ( "comparable", Set.fromList [ "Float", "Int", "Char", "String" ] )
        , ( "appendable", Set.fromList [ "String", "List" ] )
        , ( "compappend", Set.fromList [ "String" ] )
        ]


distance : Type -> Type -> Float
distance query candidate =
    typeDistance query candidate Dict.empty |> Tuple.first


typeDistance : Type -> Type -> Dict String Type -> ( Float, Dict String Type )
typeDistance q c bindings =
    case ( q, c ) of
        ( Fn qArgs qResult, Fn cArgs cResult ) ->
            fnDistance qArgs qResult cArgs cResult bindings

        ( Fn qArgs qResult, _ ) ->
            fnDistance qArgs qResult [] c bindings

        ( _, Fn cArgs cResult ) ->
            fnDistance [] q cArgs cResult bindings

        ( Var name, _ ) ->
            varDistance name c bindings

        ( _, Var name ) ->
            varDistance name q bindings

        ( App qName qArgs, App cName cArgs ) ->
            appDistance qName qArgs cName cArgs bindings

        ( Tuple qArgs, Tuple cArgs ) ->
            listDistance qArgs cArgs bindings

        ( Record qFields _, Record cFields _ ) ->
            recordDistance qFields cFields bindings

        _ ->
            ( maxPenalty, bindings )



-- FUNCTION DISTANCE


fnDistance : List Type -> Type -> List Type -> Type -> Dict String Type -> ( Float, Dict String Type )
fnDistance qArgs qResult cArgs cResult bindings =
    let
        ( resultDist, bindings1 ) =
            typeDistance qResult cResult bindings
    in
    if List.isEmpty qArgs && List.isEmpty cArgs then
        ( resultDist, bindings1 )

    else
        let
            ( shorter, longer ) =
                if List.length qArgs <= List.length cArgs then
                    ( qArgs, cArgs )

                else
                    ( cArgs, qArgs )
        in
        if List.isEmpty shorter then
            let
                argPenalty =
                    if not (List.isEmpty longer) then
                        mediumPenalty

                    else
                        noPenalty
            in
            ( (resultDist + argPenalty) / 2, bindings1 )

        else if List.length shorter > maxPermutationArgs then
            let
                ( argDist, bindings2 ) =
                    listDistance qArgs cArgs bindings1
            in
            ( (argDist + resultDist) / 2, bindings2 )

        else
            let
                ( bestArgDist, bindings2 ) =
                    bestPermutationDistance shorter longer bindings1
            in
            ( (bestArgDist + resultDist) / 2, bindings2 )


bestPermutationDistance : List Type -> List Type -> Dict String Type -> ( Float, Dict String Type )
bestPermutationDistance shorter longer bindings =
    let
        indices =
            List.range 0 (List.length longer - 1)

        perms =
            permutations indices (List.length shorter)

        identity =
            List.range 0 (List.length shorter - 1)
    in
    List.foldl
        (\perm ( bestDist, bestBindings ) ->
            let
                ( dist, permBindings ) =
                    scorePermutation shorter longer perm identity bindings
            in
            if dist < bestDist then
                ( dist, permBindings )

            else
                ( bestDist, bestBindings )
        )
        ( maxPenalty, bindings )
        perms


scorePermutation : List Type -> List Type -> List Int -> List Int -> Dict String Type -> ( Float, Dict String Type )
scorePermutation shorter longer perm identity bindings =
    let
        shorterLen =
            List.length shorter |> toFloat

        longerLen =
            List.length longer |> toFloat

        ( sum, finalBindings ) =
            List.foldl
                (\( s, idx ) ( accSum, accBindings ) ->
                    let
                        c =
                            listGet idx longer |> Maybe.withDefault (Var "_")

                        ( d, newBindings ) =
                            typeDistance s c accBindings
                    in
                    ( accSum + d, newBindings )
                )
                ( 0.0, bindings )
                (List.map2 Tuple.pair shorter perm)

        unmatchedPenalty =
            ((longerLen - shorterLen) * mediumPenalty) / longerLen

        avg =
            sum / shorterLen

        isReordered =
            perm /= List.take (List.length perm) identity

        reorderPenalty =
            if isReordered then
                permutationPenalty

            else
                0.0
    in
    ( avg * (shorterLen / longerLen) + unmatchedPenalty + reorderPenalty, finalBindings )


listGet : Int -> List a -> Maybe a
listGet idx list =
    List.drop idx list |> List.head


permutations : List Int -> Int -> List (List Int)
permutations arr k =
    if k == 0 then
        [ [] ]

    else
        List.concatMap
            (\i ->
                let
                    rest =
                        List.filter (\x -> x /= i) arr
                in
                List.map (\perm -> i :: perm) (permutations rest (k - 1))
            )
            arr



-- VARIABLE DISTANCE


resolveVar : String -> Dict String Type -> Maybe Type
resolveVar name bindings =
    resolveVarHelper name bindings Set.empty


resolveVarHelper : String -> Dict String Type -> Set String -> Maybe Type
resolveVarHelper name bindings seen =
    if Set.member name seen then
        Just (Var name)

    else
        case Dict.get name bindings of
            Nothing ->
                Nothing

            Just (Var nextName) ->
                resolveVarHelper nextName bindings (Set.insert name seen)

            Just resolved ->
                Just resolved


varDistance : String -> Type -> Dict String Type -> ( Float, Dict String Type )
varDistance varName other bindings =
    let
        resolved =
            resolveVar varName bindings
    in
    case resolved of
        Just (Var _) ->
            -- Bound to a var through a chain
            case other of
                Var _ ->
                    ( noPenalty, bindings )

                _ ->
                    -- Var bound to var, other is concrete — treat as fresh binding
                    bindAndScore varName other bindings

        Just resolvedType ->
            -- Bound to a concrete type
            case other of
                Var otherName ->
                    ( noPenalty, Dict.insert otherName resolvedType bindings )

                _ ->
                    typeDistance resolvedType other bindings

        Nothing ->
            -- Unbound — bind it
            bindAndScore varName other bindings


bindAndScore : String -> Type -> Dict String Type -> ( Float, Dict String Type )
bindAndScore varName other bindings =
    let
        newBindings =
            Dict.insert varName other bindings
    in
    case Dict.get varName reservedMatches of
        Just matchSet ->
            case other of
                App qname [] ->
                    if Set.member qname.name matchSet then
                        ( lowPenalty, newBindings )

                    else
                        ( mediumPenalty, newBindings )

                _ ->
                    ( mediumPenalty, newBindings )

        Nothing ->
            case other of
                Var _ ->
                    ( noPenalty, newBindings )

                _ ->
                    ( mediumPenalty, newBindings )



-- APP DISTANCE


appDistance : QualifiedName -> List Type -> QualifiedName -> List Type -> Dict String Type -> ( Float, Dict String Type )
appDistance qName qArgs cName cArgs bindings =
    let
        nameDist =
            nameDistance qName cName
    in
    if nameDist >= maxPenalty then
        ( maxPenalty, bindings )

    else if List.isEmpty qArgs && List.isEmpty cArgs then
        ( nameDist, bindings )

    else
        let
            ( argsDist, bindings1 ) =
                listDistance qArgs cArgs bindings
        in
        ( nameDist * 0.4 + argsDist * 0.6, bindings1 )


nameDistance : QualifiedName -> QualifiedName -> Float
nameDistance q c =
    if q.home == c.home && q.name == c.name then
        noPenalty

    else if q.name == c.name then
        if q.home == "" || c.home == "" then
            noPenalty

        else
            lowPenalty

    else
        let
            qLower =
                String.toLower q.name

            cLower =
                String.toLower c.name
        in
        if String.contains qLower cLower || String.contains cLower qLower then
            mediumPenalty

        else
            maxPenalty



-- LIST DISTANCE


listDistance : List Type -> List Type -> Dict String Type -> ( Float, Dict String Type )
listDistance qs cs bindings =
    if List.isEmpty qs && List.isEmpty cs then
        ( noPenalty, bindings )

    else
        let
            maxLen =
                max (List.length qs) (List.length cs)

            ( sum, finalBindings ) =
                listDistanceHelper qs cs 0 0.0 bindings
        in
        ( (sum + toFloat (maxLen - max (List.length qs) (List.length cs)) * maxPenalty) / toFloat maxLen, finalBindings )


listDistanceHelper : List Type -> List Type -> Int -> Float -> Dict String Type -> ( Float, Dict String Type )
listDistanceHelper qs cs idx sum bindings =
    case ( qs, cs ) of
        ( q :: qRest, c :: cRest ) ->
            let
                ( d, b ) =
                    typeDistance q c bindings
            in
            listDistanceHelper qRest cRest (idx + 1) (sum + d) b

        ( [], [] ) ->
            ( sum, bindings )

        ( _ :: qRest, [] ) ->
            listDistanceHelper qRest [] (idx + 1) (sum + maxPenalty) bindings

        ( [], _ :: cRest ) ->
            listDistanceHelper [] cRest (idx + 1) (sum + maxPenalty) bindings



-- RECORD DISTANCE


recordDistance : List ( String, Type ) -> List ( String, Type ) -> Dict String Type -> ( Float, Dict String Type )
recordDistance qFields cFields bindings =
    if List.isEmpty qFields && List.isEmpty cFields then
        ( noPenalty, bindings )

    else
        let
            cDict =
                Dict.fromList cFields

            ( matchedSum, matchedCount, bindings1 ) =
                List.foldl
                    (\( name, qType ) ( s, cnt, b ) ->
                        case Dict.get name cDict of
                            Just cType ->
                                let
                                    ( d, b1 ) =
                                        typeDistance qType cType b
                                in
                                ( s + d, cnt + 1, b1 )

                            Nothing ->
                                ( s + maxPenalty, cnt, b )
                    )
                    ( 0.0, 0, bindings )
                    qFields

            total =
                max (List.length qFields) (List.length cFields)

            unmatched =
                total - matchedCount

            finalSum =
                matchedSum + toFloat unmatched * maxPenalty
        in
        ( finalSum / toFloat total, bindings1 )



-- PACKAGE BOOST


packageBoost : String -> String -> Float
packageBoost org name =
    if org == "elm" && name == "core" then
        -0.125

    else if org == "elm" then
        -0.083

    else if org == "elm-community" || org == "elm-explorations" then
        -0.0625

    else
        0.0
