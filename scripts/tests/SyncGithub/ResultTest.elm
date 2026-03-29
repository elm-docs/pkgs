module SyncGithub.ResultTest exposing (suite)

import Expect
import Json.Decode
import Sync.Fetch exposing (WriteAction(..))
import SyncGithub.Result as GhResult exposing (GithubResult(..))
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "SyncGithub.Result"
        [ describe "onResult"
            [ test "Info writes github.json, deletes other three files" <|
                \() ->
                    GhResult.onResult "elm" "core" (Info "{\"stars\":100}")
                        |> Expect.equal
                            [ WriteFile { path = "../package-elm-lang-org/content/packages/elm/core/github.json", body = "{\"stars\":100}" }
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-redirect.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-missing.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-errors.json"
                            ]
            , test "Redirect writes github-redirect.json, deletes other three files" <|
                \() ->
                    GhResult.onResult "elm" "core" (Redirect "{\"redirected\":true}")
                        |> Expect.equal
                            [ WriteFile { path = "../package-elm-lang-org/content/packages/elm/core/github-redirect.json", body = "{\"redirected\":true}" }
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-missing.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-errors.json"
                            ]
            , test "Missing writes github-missing.json, deletes other three files" <|
                \() ->
                    GhResult.onResult "elm" "core" (Missing "{\"missing\":true}")
                        |> Expect.equal
                            [ WriteFile { path = "../package-elm-lang-org/content/packages/elm/core/github-missing.json", body = "{\"missing\":true}" }
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-redirect.json"
                            , DeleteFile "../package-elm-lang-org/content/packages/elm/core/github-errors.json"
                            ]
            ]
        , describe "onError"
            [ test "writes github-errors.json with valid JSON, deletes others" <|
                \() ->
                    let
                        actions : List WriteAction
                        actions =
                            GhResult.onError "elm" "core"
                                { reason = "not_found"
                                , status = Just 404
                                , error = "Repository not found"
                                , failedAt = "2024-01-10T00:00:00Z"
                                }
                    in
                    case actions of
                        (WriteFile { path, body }) :: rest ->
                            Expect.all
                                [ \() ->
                                    Expect.equal
                                        "../package-elm-lang-org/content/packages/elm/core/github-errors.json"
                                        path
                                , \() ->
                                    case Json.Decode.decodeString (Json.Decode.field "reason" Json.Decode.string) body of
                                        Ok r ->
                                            Expect.equal "not_found" r

                                        Err e ->
                                            Expect.fail (Json.Decode.errorToString e)
                                , \() ->
                                    case Json.Decode.decodeString (Json.Decode.field "status" (Json.Decode.nullable Json.Decode.int)) body of
                                        Ok s ->
                                            Expect.equal (Just 404) s

                                        Err e ->
                                            Expect.fail (Json.Decode.errorToString e)
                                , \() -> Expect.equal 3 (List.length rest)
                                ]
                                ()

                        _ ->
                            Expect.fail "Expected WriteFile as first action"
            ]
        ]
