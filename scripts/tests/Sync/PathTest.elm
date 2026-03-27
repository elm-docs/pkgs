module Sync.PathTest exposing (suite)

import Expect
import Shared.PackageVersion as PackageVersion
import Sync.Path as Path
import Test exposing (Test, describe, test)


pv : String -> String -> String -> PackageVersion.PackageVersion
pv o p v =
    PackageVersion.fromString (o ++ "/" ++ p ++ "@" ++ v)
        |> Maybe.withDefault (PackageVersion.fromString "x/x@0" |> Maybe.withDefault (PackageVersion.fromString "x/x@0" |> Maybe.withDefault (Debug.todo "impossible")))


suite : Test
suite =
    let
        elmCore =
            case PackageVersion.fromString "elm/core@1.0.5" of
                Just p ->
                    p

                Nothing ->
                    Debug.todo "test setup: invalid package string"
    in
    describe "Path"
        [ describe "toVersionDir"
            [ test "builds version directory path" <|
                \() ->
                    Path.toVersionDir elmCore
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/1.0.5"
            ]
        , describe "toDocsUrl"
            [ test "builds docs.json URL" <|
                \() ->
                    Path.toDocsUrl elmCore
                        |> Expect.equal "https://package.elm-lang.org/packages/elm/core/1.0.5/docs.json"
            ]
        , describe "toDocsPath"
            [ test "builds docs.json path" <|
                \() ->
                    Path.toDocsPath elmCore
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/1.0.5/docs.json"
            ]
        , describe "toErrorsPath"
            [ test "builds errors.json path" <|
                \() ->
                    Path.toErrorsPath elmCore
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/1.0.5/errors.json"
            ]
        , describe "toPendingPath"
            [ test "builds pending path" <|
                \() ->
                    Path.toPendingPath elmCore
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/1.0.5/pending"
            ]
        ]
