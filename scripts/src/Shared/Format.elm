module Shared.Format exposing (formatFloat)

{-| Shared formatting utilities.
-}

{-| Format a Float to a fixed number of decimal places.
-}
formatFloat : Int -> Float -> String
formatFloat decimals f =
    let
        multiplier : Float
        multiplier =
            toFloat (10 ^ decimals)

        rounded : Float
        rounded =
            toFloat (round (f * multiplier)) / multiplier

        str : String
        str =
            String.fromFloat rounded

        parts : List String
        parts =
            String.split "." str
    in
    case parts of
        [ whole, frac ] ->
            whole ++ "." ++ String.padRight decimals '0' frac

        [ whole ] ->
            whole ++ "." ++ String.repeat decimals "0"

        _ ->
            str
