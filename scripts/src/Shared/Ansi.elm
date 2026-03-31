module Shared.Ansi exposing (bold, dim, green, red, yellow)

{-| ANSI escape code helpers for terminal output formatting.
-}

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
