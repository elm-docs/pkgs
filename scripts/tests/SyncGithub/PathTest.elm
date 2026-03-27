module SyncGithub.PathTest exposing (suite)

import Expect
import SyncGithub.Path as Path
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "SyncGithub.Path"
        [ describe "toPackageDir"
            [ test "builds package directory path" <|
                \() ->
                    Path.toPackageDir "elm" "core"
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core"
            ]
        , describe "toGithubInfoPath"
            [ test "builds github.json path" <|
                \() ->
                    Path.toGithubInfoPath "elm" "core"
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/github.json"
            ]
        , describe "toGithubRedirectPath"
            [ test "builds github-redirect.json path" <|
                \() ->
                    Path.toGithubRedirectPath "elm" "core"
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/github-redirect.json"
            ]
        , describe "toGithubMissingPath"
            [ test "builds github-missing.json path" <|
                \() ->
                    Path.toGithubMissingPath "elm" "core"
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/github-missing.json"
            ]
        , describe "toGithubErrorsPath"
            [ test "builds github-errors.json path" <|
                \() ->
                    Path.toGithubErrorsPath "elm" "core"
                        |> Expect.equal "../package-elm-lang-org/content/packages/elm/core/github-errors.json"
            ]
        , describe "toPackageKey"
            [ test "builds org/pkg key" <|
                \() ->
                    Path.toPackageKey "elm" "core"
                        |> Expect.equal "elm/core"
            ]
        ]
