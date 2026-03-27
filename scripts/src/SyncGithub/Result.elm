module SyncGithub.Result exposing (GithubResult(..), onError, onResult)

import Json.Encode as Encode
import Sync.Fetch exposing (WriteAction(..))
import SyncGithub.Path as Path


{-| Each variant carries the pre-encoded JSON body to write.
-}
type GithubResult
    = Info String
    | Redirect String
    | Missing String


onResult : String -> String -> GithubResult -> List WriteAction
onResult org pkg result =
    let
        infoPath =
            Path.toGithubInfoPath org pkg

        redirectPath =
            Path.toGithubRedirectPath org pkg

        missingPath =
            Path.toGithubMissingPath org pkg

        errorsPath =
            Path.toGithubErrorsPath org pkg
    in
    case result of
        Info body ->
            [ WriteFile { path = infoPath, body = body }
            , DeleteFile redirectPath
            , DeleteFile missingPath
            , DeleteFile errorsPath
            ]

        Redirect body ->
            [ WriteFile { path = redirectPath, body = body }
            , DeleteFile infoPath
            , DeleteFile missingPath
            , DeleteFile errorsPath
            ]

        Missing body ->
            [ WriteFile { path = missingPath, body = body }
            , DeleteFile infoPath
            , DeleteFile redirectPath
            , DeleteFile errorsPath
            ]


onError :
    String
    -> String
    -> { reason : String, status : Maybe Int, error : String, failedAt : String }
    -> List WriteAction
onError org pkg { reason, status, error, failedAt } =
    let
        errorsPath =
            Path.toGithubErrorsPath org pkg

        body =
            Encode.encode 2
                (Encode.object
                    [ ( "repo", Encode.string (org ++ "/" ++ pkg) )
                    , ( "reason", Encode.string reason )
                    , ( "status"
                      , case status of
                            Just s ->
                                Encode.int s

                            Nothing ->
                                Encode.null
                      )
                    , ( "error", Encode.string error )
                    , ( "failed_at", Encode.string failedAt )
                    ]
                )
    in
    [ WriteFile { path = errorsPath, body = body }
    , DeleteFile (Path.toGithubInfoPath org pkg)
    , DeleteFile (Path.toGithubRedirectPath org pkg)
    , DeleteFile (Path.toGithubMissingPath org pkg)
    ]
