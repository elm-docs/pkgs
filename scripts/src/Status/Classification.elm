module Status.Classification exposing
    ( FileIndex
    , Status(..)
    , Summary
    , classify
    , classifyAll
    , summarize
    )

import Set exposing (Set)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)


type Status
    = Success
    | Failure
    | Pending
    | Missing


type alias FileIndex =
    { docsFiles : Set String
    , errorsFiles : Set String
    , pendingFiles : Set String
    }


classify : FileIndex -> String -> Status
classify index key =
    if Set.member key index.pendingFiles then
        Pending

    else if Set.member key index.errorsFiles then
        Failure

    else if Set.member key index.docsFiles then
        Success

    else
        Missing


type alias Classified =
    { success : List PackageVersion
    , failure : List PackageVersion
    , pending : List PackageVersion
    , missing : List PackageVersion
    }


classifyAll : FileIndex -> List PackageVersion -> Classified
classifyAll index packages =
    List.foldl
        (\pv acc ->
            let
                key =
                    PackageVersion.toKey pv
            in
            case classify index key of
                Success ->
                    { acc | success = pv :: acc.success }

                Failure ->
                    { acc | failure = pv :: acc.failure }

                Pending ->
                    { acc | pending = pv :: acc.pending }

                Missing ->
                    { acc | missing = pv :: acc.missing }
        )
        { success = [], failure = [], pending = [], missing = [] }
        packages


type alias Summary =
    { total : Int
    , success : Int
    , failure : Int
    , pending : Int
    , missing : Int
    }


summarize : Classified -> Summary
summarize classified =
    let
        s =
            List.length classified.success

        f =
            List.length classified.failure

        p =
            List.length classified.pending

        m =
            List.length classified.missing
    in
    { total = s + f + p + m
    , success = s
    , failure = f
    , pending = p
    , missing = m
    }
