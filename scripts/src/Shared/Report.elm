module Shared.Report exposing (formatDetailList, formatPercent, formatSummary)

{-| Formatting helpers for the status report output.
-}

import Shared.Ansi exposing (bold, dim, green, red, yellow)
import Shared.PackageVersion as PackageVersion exposing (PackageVersion)
import Status.Classification exposing (Summary)


maxDisplay : Int
maxDisplay =
    5



-- Formatting


formatPercent : Int -> Int -> String
formatPercent part total =
    if total == 0 then
        "0.0%"

    else
        let
            scaled : Int
            scaled =
                (part * 1000) // total

            whole : Int
            whole =
                scaled // 10

            frac : Int
            frac =
                modBy 10 scaled
        in
        String.fromInt whole ++ "." ++ String.fromInt frac ++ "%"


formatSummary : Summary -> String
formatSummary summary =
    let
        pct : String
        pct =
            formatPercent summary.success summary.total

        separator : String
        separator =
            String.repeat 40 "─"
    in
    String.join "\n"
        [ bold "Package Sync Status"
        , separator
        , "  Total packages:  " ++ bold (String.fromInt summary.total)
        , "  " ++ green "✓" ++ " Synced:        " ++ bold (String.fromInt summary.success) ++ " " ++ dim ("(" ++ pct ++ ")")
        , "  " ++ yellow "◷" ++ " Pending:       " ++ bold (String.fromInt summary.pending)
        , "  " ++ red "✗" ++ " Errors:        " ++ bold (String.fromInt summary.failure)
        , "  " ++ dim "○" ++ " Missing:       " ++ bold (String.fromInt summary.missing)
        ]


formatDetailList : String -> (String -> String) -> List PackageVersion -> String
formatDetailList title color packages =
    if List.isEmpty packages then
        ""

    else
        let
            shown : List PackageVersion
            shown =
                List.take maxDisplay packages

            remaining : Int
            remaining =
                List.length packages - List.length shown

            header : String
            header =
                color (bold title)

            items : List String
            items =
                List.map
                    (\pv -> "  " ++ dim "•" ++ " " ++ PackageVersion.toLabel pv)
                    shown

            footer : List String
            footer =
                if remaining > 0 then
                    [ dim ("  … and " ++ String.fromInt remaining ++ " more") ]

                else
                    []
        in
        String.join "\n" (header :: items ++ footer)
