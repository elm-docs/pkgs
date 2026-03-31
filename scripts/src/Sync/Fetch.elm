module Sync.Fetch exposing (WriteAction(..), onFailure, onSuccess, toErrorJson)

{-| File write actions for package doc fetching (success and failure paths).
-}

import Json.Encode as Encode


type WriteAction
    = WriteFile { path : String, body : String }
    | DeleteFile String


onSuccess : { docsPath : String, pendingPath : String, errorsPath : String, body : String } -> List WriteAction
onSuccess { docsPath, pendingPath, errorsPath, body } =
    [ WriteFile { path = docsPath, body = body }
    , DeleteFile pendingPath
    , DeleteFile errorsPath
    ]


onFailure : { docsPath : String, pendingPath : String, errorsPath : String, url : String, error : String } -> List WriteAction
onFailure { docsPath, pendingPath, errorsPath, url, error } =
    [ WriteFile { path = docsPath, body = "" }
    , WriteFile { path = errorsPath, body = toErrorJson url error }
    , DeleteFile pendingPath
    ]


toErrorJson : String -> String -> String
toErrorJson url error =
    Encode.encode 2
        (Encode.object
            [ ( "url", Encode.string url )
            , ( "error", Encode.string error )
            ]
        )
