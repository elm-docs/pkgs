module Shared.CliHelpers exposing (parseFloatOpt, parseIntOpt)

{-| Shared CLI option parsing helpers used across script entry points.
-}

parseIntOpt : String -> Int -> Maybe String -> Result String Int
parseIntOpt name default_ maybeStr =
    case maybeStr of
        Nothing ->
            Ok default_

        Just str ->
            case String.toInt str of
                Just n ->
                    Ok n

                Nothing ->
                    Err ("Invalid --" ++ name ++ " value: " ++ str)


parseFloatOpt : String -> Float -> Maybe String -> Result String Float
parseFloatOpt name default_ maybeStr =
    case maybeStr of
        Nothing ->
            Ok default_

        Just str ->
            case String.toFloat str of
                Just f ->
                    Ok f

                Nothing ->
                    Err ("Invalid --" ++ name ++ " value: " ++ str)
