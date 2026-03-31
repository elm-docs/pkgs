module Sync.Discovery exposing (filterNew)

{-| Filters package versions to find those not yet synced locally.
-}

import Set exposing (Set)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)


filterNew : Set String -> List String -> List PackageVersion
filterNew existingKeys rawStrings =
    rawStrings
        |> List.filterMap PackageVersion.fromString
        |> List.filter (\pv -> not (Set.member (PackageVersion.toKey pv) existingKeys))
