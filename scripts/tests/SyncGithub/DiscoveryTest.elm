module SyncGithub.DiscoveryTest exposing (suite)

import Expect
import Set
import SyncGithub.Discovery as Discovery exposing (PackageId(..))
import Test exposing (Test, describe, test)


pkg : String -> String -> PackageId
pkg =
    PackageId


suite : Test
suite =
    describe "SyncGithub.Discovery"
        [ describe "filterNeedingGithub"
            [ test "update=True returns all packages regardless of existing info" <|
                \() ->
                    Discovery.filterNeedingGithub True
                        (Set.fromList [ "elm/core", "elm/json" ])
                        [ pkg "elm" "core", pkg "elm" "json" ]
                        |> Expect.equal [ pkg "elm" "core", pkg "elm" "json" ]
            , test "filters out packages with existing github info" <|
                \() ->
                    Discovery.filterNeedingGithub False
                        (Set.singleton "elm/core")
                        [ pkg "elm" "core", pkg "elm" "json" ]
                        |> Expect.equal [ pkg "elm" "json" ]
            , test "returns all when no existing info" <|
                \() ->
                    Discovery.filterNeedingGithub False
                        Set.empty
                        [ pkg "elm" "core", pkg "elm" "json" ]
                        |> Expect.equal [ pkg "elm" "core", pkg "elm" "json" ]
            , test "returns empty for empty input" <|
                \() ->
                    Discovery.filterNeedingGithub False Set.empty []
                        |> Expect.equal []
            , test "returns empty when all packages have info" <|
                \() ->
                    Discovery.filterNeedingGithub False
                        (Set.fromList [ "elm/core", "elm/json" ])
                        [ pkg "elm" "core", pkg "elm" "json" ]
                        |> Expect.equal []
            ]
        , describe "toKey"
            [ test "formats as org/pkg" <|
                \() ->
                    Discovery.toKey (pkg "elm" "core")
                        |> Expect.equal "elm/core"
            ]
        ]
