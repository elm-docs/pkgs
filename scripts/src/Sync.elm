module Sync exposing (run)

{-| Orchestrator that runs SyncElmPackages then SyncGithub sequentially.
-}

import BackendTask exposing (BackendTask)
import BackendTask.Env
import BackendTask.Stream as Stream
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import FatalError exposing (FatalError)
import Pages.Script as Script exposing (Script)
import Shared.CliHelpers exposing (parseIntOpt)


type alias CliOptions =
    { concurrency : Int
    , delay : Int
    , since : Maybe Int
    , githubConcurrency : Int
    , githubDelay : Int
    , update : Bool
    , token : Maybe String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            runSyncElmPackages options
                |> BackendTask.andThen (\() -> runSyncGithub options)
        )


runSyncElmPackages : CliOptions -> BackendTask FatalError ()
runSyncElmPackages options =
    let
        args : List String
        args =
            [ "--concurrency", String.fromInt options.concurrency
            , "--delay", String.fromInt options.delay
            ]
                ++ (case options.since of
                        Just n ->
                            [ "--since", String.fromInt n ]

                        Nothing ->
                            []
                   )
    in
    Stream.command "elm-pages" ("run" :: "src/SyncElmPackages.elm" :: "--" :: args)
        |> Stream.run


runSyncGithub : CliOptions -> BackendTask FatalError ()
runSyncGithub options =
    resolveToken options.token
        |> BackendTask.andThen
            (\maybeToken ->
                let
                    args : List String
                    args =
                        [ "--concurrency", String.fromInt options.githubConcurrency
                        , "--delay", String.fromInt options.githubDelay
                        ]
                            ++ (if options.update then
                                    [ "--update" ]

                                else
                                    []
                               )
                            ++ (case maybeToken of
                                    Just t ->
                                        [ "--token", t ]

                                    Nothing ->
                                        []
                               )
                in
                Stream.command "elm-pages" ("run" :: "src/SyncGithub.elm" :: "--" :: args)
                    |> Stream.run
            )


resolveToken : Maybe String -> BackendTask FatalError (Maybe String)
resolveToken cliToken =
    case cliToken of
        Just _ ->
            BackendTask.succeed cliToken

        Nothing ->
            BackendTask.Env.get "GITHUB_TOKEN"


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with
                    (Option.optionalKeywordArg "concurrency"
                        |> Option.validateMap (parseIntOpt "concurrency" 6)
                    )
                |> with
                    (Option.optionalKeywordArg "delay"
                        |> Option.validateMap (parseIntOpt "delay" 100)
                    )
                |> with
                    (Option.optionalKeywordArg "since"
                        |> Option.validateMap
                            (\maybeStr ->
                                case maybeStr of
                                    Nothing ->
                                        Ok Nothing

                                    Just str ->
                                        case String.toInt str of
                                            Just n ->
                                                Ok (Just n)

                                            Nothing ->
                                                Err ("Invalid since value: " ++ str)
                            )
                    )
                |> with
                    (Option.optionalKeywordArg "github-concurrency"
                        |> Option.validateMap (parseIntOpt "github-concurrency" 2)
                    )
                |> with
                    (Option.optionalKeywordArg "github-delay"
                        |> Option.validateMap (parseIntOpt "github-delay" 500)
                    )
                |> with (Option.flag "update")
                |> with (Option.optionalKeywordArg "token")
            )


