module Sync.DiscoveryTest exposing (suite)

import Expect
import Set
import Shared.PackageVersion as PackageVersion
import Sync.Discovery as Discovery
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "Discovery"
        [ describe "filterNew"
            [ test "all packages are new when no existing keys" <|
                \() ->
                    Discovery.filterNew Set.empty
                        [ "elm/core@1.0.5"
                        , "elm/json@1.1.3"
                        ]
                        |> List.map PackageVersion.toKey
                        |> Expect.equal [ "elm/core@1.0.5", "elm/json@1.1.3" ]
            , test "filters out packages that already exist" <|
                \() ->
                    Discovery.filterNew
                        (Set.singleton "elm/core@1.0.5")
                        [ "elm/core@1.0.5"
                        , "elm/json@1.1.3"
                        ]
                        |> List.map PackageVersion.toKey
                        |> Expect.equal [ "elm/json@1.1.3" ]
            , test "returns empty list when all exist" <|
                \() ->
                    Discovery.filterNew
                        (Set.fromList [ "elm/core@1.0.5", "elm/json@1.1.3" ])
                        [ "elm/core@1.0.5"
                        , "elm/json@1.1.3"
                        ]
                        |> Expect.equal []
            , test "returns empty list for empty input" <|
                \() ->
                    Discovery.filterNew Set.empty []
                        |> Expect.equal []
            , test "skips unparseable package strings" <|
                \() ->
                    Discovery.filterNew Set.empty
                        [ "elm/core@1.0.5"
                        , "invalid-no-version"
                        , "elm/json@1.1.3"
                        ]
                        |> List.map PackageVersion.toKey
                        |> Expect.equal [ "elm/core@1.0.5", "elm/json@1.1.3" ]
            ]
        ]
