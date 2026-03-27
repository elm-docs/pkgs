module SyncGithub.DateStats exposing (DateStats, IssueInfo, computeDateStats, daysSince)

import Iso8601
import Time


type alias IssueInfo =
    { number : Int
    , createdAt : String
    , lastCommentAt : Maybe String
    , lastCommentByMaintainer : Maybe Bool
    }


type alias DateStats =
    { count : Int
    , minDays : Int
    , maxDays : Int
    , avgDays : Int
    , items : List IssueInfo
    }


daysSince : Time.Posix -> String -> Int
daysSince now dateStr =
    case Iso8601.toTime dateStr of
        Ok past ->
            let
                ms =
                    Time.posixToMillis now - Time.posixToMillis past
            in
            round (toFloat ms / (1000 * 60 * 60 * 24))

        Err _ ->
            0


computeDateStats : Time.Posix -> List IssueInfo -> DateStats
computeDateStats now items =
    case items of
        [] ->
            { count = 0, minDays = 0, maxDays = 0, avgDays = 0, items = [] }

        _ ->
            let
                ages =
                    List.map (\item -> daysSince now item.createdAt) items

                minAge =
                    List.minimum ages |> Maybe.withDefault 0

                maxAge =
                    List.maximum ages |> Maybe.withDefault 0

                avgAge =
                    round (toFloat (List.sum ages) / toFloat (List.length ages))
            in
            { count = List.length items
            , minDays = minAge
            , maxDays = maxAge
            , avgDays = avgAge
            , items = items
            }
