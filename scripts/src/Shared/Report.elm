module Shared.Report exposing (formatDetailList, formatPercent, formatSummary)

import Shared.PackageVersion as PackageVersion exposing (PackageVersion)
import Status.Classification exposing (Summary)


maxDisplay : Int
maxDisplay =
    5



-- ANSI helpers


bold : String -> String
bold s =
    "\u{001B}[1m" ++ s ++ "\u{001B}[0m"


green : String -> String
green s =
    "\u{001B}[32m" ++ s ++ "\u{001B}[0m"


red : String -> String
red s =
    "\u{001B}[31m" ++ s ++ "\u{001B}[0m"


yellow : String -> String
yellow s =
    "\u{001B}[33m" ++ s ++ "\u{001B}[0m"


dim : String -> String
dim s =
    "\u{001B}[2m" ++ s ++ "\u{001B}[0m"



-- Formatting


formatPercent : Int -> Int -> String
formatPercent part total =
    if total == 0 then
        "0.0%"

    else
        let
            scaled =
                (part * 1000) // total

            whole =
                scaled // 10

            frac =
                modBy 10 scaled
        in
        String.fromInt whole ++ "." ++ String.fromInt frac ++ "%"


formatSummary : Summary -> String
formatSummary summary =
    let
        pct =
            formatPercent summary.success summary.total

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
            shown =
                List.take maxDisplay packages

            remaining =
                List.length packages - List.length shown

            header =
                color (bold title)

            items =
                List.map
                    (\pv -> "  " ++ dim "•" ++ " " ++ PackageVersion.toLabel pv)
                    shown

            footer =
                if remaining > 0 then
                    [ dim ("  … and " ++ String.fromInt remaining ++ " more") ]

                else
                    []
        in
        String.join "\n" (header :: items ++ footer)
