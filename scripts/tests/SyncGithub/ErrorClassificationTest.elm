module SyncGithub.ErrorClassificationTest exposing (suite)

import Expect
import SyncGithub.ErrorClassification as ErrorClassification exposing (ErrorReason(..))
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "ErrorClassification"
        [ describe "classifyResponse"
            [ test "403 with rate limit message → RateLimit" <|
                \() ->
                    ErrorClassification.classifyResponse 403 "API rate limit exceeded"
                        |> Expect.equal RateLimit
            , test "429 with rate limit message → RateLimit" <|
                \() ->
                    ErrorClassification.classifyResponse 429 "rate limit exceeded"
                        |> Expect.equal RateLimit
            , test "403 with other message → Forbidden" <|
                \() ->
                    ErrorClassification.classifyResponse 403 "Resource not accessible"
                        |> Expect.equal Forbidden
            , test "404 → NotFound" <|
                \() ->
                    ErrorClassification.classifyResponse 404 "Not Found"
                        |> Expect.equal NotFound
            , test "301 → Moved" <|
                \() ->
                    ErrorClassification.classifyResponse 301 ""
                        |> Expect.equal Moved
            , test "message containing 'moved permanently' → Moved" <|
                \() ->
                    ErrorClassification.classifyResponse 200 "This repository has moved permanently"
                        |> Expect.equal Moved
            , test "message containing 'repository.*changed' → Moved" <|
                \() ->
                    ErrorClassification.classifyResponse 200 "repository name changed to new/name"
                        |> Expect.equal Moved
            , test "500 with unknown message → Unknown" <|
                \() ->
                    ErrorClassification.classifyResponse 500 "Internal Server Error"
                        |> Expect.equal Unknown
            , test "empty message with non-error status → Unknown" <|
                \() ->
                    ErrorClassification.classifyResponse 502 ""
                        |> Expect.equal Unknown
            ]
        , describe "reasonToString"
            [ test "RateLimit → rate_limit" <|
                \() ->
                    ErrorClassification.reasonToString RateLimit
                        |> Expect.equal "rate_limit"
            , test "NotFound → not_found" <|
                \() ->
                    ErrorClassification.reasonToString NotFound
                        |> Expect.equal "not_found"
            ]
        ]
