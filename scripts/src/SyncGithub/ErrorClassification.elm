module SyncGithub.ErrorClassification exposing (ErrorReason(..), classifyResponse, reasonToString)


type ErrorReason
    = RateLimit
    | NotFound
    | Moved
    | Forbidden
    | NetworkError
    | Unknown


classifyResponse : Int -> String -> ErrorReason
classifyResponse status message =
    let
        lower =
            String.toLower message
    in
    if status == 403 || status == 429 then
        if String.contains "rate limit" lower then
            RateLimit

        else
            Forbidden

    else if status == 404 then
        NotFound

    else if status == 301 then
        Moved

    else if String.contains "moved permanently" lower || (String.contains "repository" lower && String.contains "changed" lower) then
        Moved

    else
        Unknown


reasonToString : ErrorReason -> String
reasonToString reason =
    case reason of
        RateLimit ->
            "rate_limit"

        NotFound ->
            "not_found"

        Moved ->
            "moved"

        Forbidden ->
            "forbidden"

        NetworkError ->
            "network"

        Unknown ->
            "unknown"
