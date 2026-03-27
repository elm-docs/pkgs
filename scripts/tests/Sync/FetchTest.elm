module Sync.FetchTest exposing (suite)

import Expect
import Json.Decode
import Sync.Fetch as Fetch exposing (WriteAction(..))
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "Fetch"
        [ describe "onSuccess"
            [ test "writes docs body, deletes pending and errors" <|
                \() ->
                    Fetch.onSuccess
                        { docsPath = "packages/elm/core/1.0.5/docs.json"
                        , pendingPath = "packages/elm/core/1.0.5/pending"
                        , errorsPath = "packages/elm/core/1.0.5/errors.json"
                        , body = "[{\"name\":\"String\"}]"
                        }
                        |> Expect.equal
                            [ WriteFile { path = "packages/elm/core/1.0.5/docs.json", body = "[{\"name\":\"String\"}]" }
                            , DeleteFile "packages/elm/core/1.0.5/pending"
                            , DeleteFile "packages/elm/core/1.0.5/errors.json"
                            ]
            ]
        , describe "onFailure"
            [ test "writes empty docs, writes errors json, deletes pending" <|
                \() ->
                    let
                        actions =
                            Fetch.onFailure
                                { docsPath = "packages/elm/core/1.0.5/docs.json"
                                , pendingPath = "packages/elm/core/1.0.5/pending"
                                , errorsPath = "packages/elm/core/1.0.5/errors.json"
                                , url = "https://package.elm-lang.org/packages/elm/core/1.0.5/docs.json"
                                , error = "HTTP 404 Not Found"
                                }
                    in
                    case actions of
                        [ WriteFile docs, WriteFile errors, DeleteFile pending ] ->
                            Expect.all
                                [ \() -> Expect.equal "" docs.body
                                , \() -> Expect.equal "packages/elm/core/1.0.5/docs.json" docs.path
                                , \() -> Expect.equal "packages/elm/core/1.0.5/errors.json" errors.path
                                , \() -> Expect.equal "packages/elm/core/1.0.5/pending" pending
                                , \() ->
                                    -- errors body should be valid JSON with url and error fields
                                    case Json.Decode.decodeString (Json.Decode.map2 Tuple.pair (Json.Decode.field "url" Json.Decode.string) (Json.Decode.field "error" Json.Decode.string)) errors.body of
                                        Ok ( url, error ) ->
                                            Expect.all
                                                [ \() -> Expect.equal "https://package.elm-lang.org/packages/elm/core/1.0.5/docs.json" url
                                                , \() -> Expect.equal "HTTP 404 Not Found" error
                                                ]
                                                ()

                                        Err e ->
                                            Expect.fail ("errors body is not valid JSON: " ++ Json.Decode.errorToString e)
                                ]
                                ()

                        _ ->
                            Expect.fail ("Expected [WriteFile, WriteFile, DeleteFile] but got " ++ Debug.toString actions)
            ]
        , describe "toErrorJson"
            [ test "produces valid JSON with url and error fields" <|
                \() ->
                    let
                        json =
                            Fetch.toErrorJson "https://example.com/docs.json" "connection timeout"
                    in
                    case Json.Decode.decodeString (Json.Decode.map2 Tuple.pair (Json.Decode.field "url" Json.Decode.string) (Json.Decode.field "error" Json.Decode.string)) json of
                        Ok ( url, error ) ->
                            Expect.all
                                [ \() -> Expect.equal "https://example.com/docs.json" url
                                , \() -> Expect.equal "connection timeout" error
                                ]
                                ()

                        Err e ->
                            Expect.fail ("Not valid JSON: " ++ Json.Decode.errorToString e)
            ]
        ]
