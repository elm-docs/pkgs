module Sync.Discovery exposing (filterNew)

import Set exposing (Set)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)


filterNew : Set String -> List String -> List PackageVersion
filterNew existingKeys rawStrings =
    rawStrings
        |> List.filterMap PackageVersion.fromString
        |> List.filter (\pv -> not (Set.member (PackageVersion.toKey pv) existingKeys))
