module SyncGithub.Discovery exposing (PackageId(..), filterNeedingGithub, toKey)

import Set exposing (Set)


type PackageId
    = PackageId String String


toKey : PackageId -> String
toKey (PackageId org pkg) =
    org ++ "/" ++ pkg


filterNeedingGithub : Bool -> Set String -> List PackageId -> List PackageId
filterNeedingGithub update existingKeys packages =
    if update then
        packages

    else
        List.filter (\p -> not (Set.member (toKey p) existingKeys)) packages
