module Shared.PackageVersionTest exposing (suite)

import Expect
import Shared.PackageVersion as PackageVersion
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "PackageVersion"
        [ describe "fromString"
            [ test "parses elm/core@1.0.5" <|
                \() ->
                    let
                        result =
                            PackageVersion.fromString "elm/core@1.0.5"
                    in
                    case result of
                        Just pv ->
                            Expect.all
                                [ \_ -> Expect.equal "elm" (PackageVersion.org pv)
                                , \_ -> Expect.equal "core" (PackageVersion.pkg pv)
                                , \_ -> Expect.equal "1.0.5" (PackageVersion.version pv)
                                ]
                                ()

                        Nothing ->
                            Expect.fail "Expected Just, got Nothing"
            , test "parses author/my-package@2.0.0" <|
                \() ->
                    let
                        result =
                            PackageVersion.fromString "author/my-package@2.0.0"
                    in
                    case result of
                        Just pv ->
                            Expect.all
                                [ \_ -> Expect.equal "author" (PackageVersion.org pv)
                                , \_ -> Expect.equal "my-package" (PackageVersion.pkg pv)
                                , \_ -> Expect.equal "2.0.0" (PackageVersion.version pv)
                                ]
                                ()

                        Nothing ->
                            Expect.fail "Expected Just, got Nothing"
            , test "rejects empty string" <|
                \() ->
                    PackageVersion.fromString ""
                        |> Expect.equal Nothing
            , test "rejects noversion" <|
                \() ->
                    PackageVersion.fromString "noversion"
                        |> Expect.equal Nothing
            , test "rejects no/at-sign" <|
                \() ->
                    PackageVersion.fromString "no/at-sign"
                        |> Expect.equal Nothing
            , test "rejects @1.0.0" <|
                \() ->
                    PackageVersion.fromString "@1.0.0"
                        |> Expect.equal Nothing
            , test "rejects /pkg@1.0.0" <|
                \() ->
                    PackageVersion.fromString "/pkg@1.0.0"
                        |> Expect.equal Nothing
            ]
        , describe "toLabel round-trip"
            [ test "fromString >> toLabel equals original" <|
                \() ->
                    let
                        original =
                            "elm/core@1.0.5"
                    in
                    PackageVersion.fromString original
                        |> Maybe.map PackageVersion.toLabel
                        |> Expect.equal (Just original)
            ]
        ]
