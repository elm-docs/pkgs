module SyncGithub exposing (run)

{-| Fetch GitHub metadata for each package directly into SQLite.

For each package needing metadata:

  - `info` — stars, last commit, open issues/PRs with age stats
  - `redirect` — repo was renamed or moved
  - `missing` — repo or user no longer exists (404)

Uses smart frequency: active packages (committed within 6 months) are
re-fetched daily, inactive packages weekly. Use `--force` to re-fetch all.

Reads GitHub's `x-ratelimit-remaining` and `retry-after` headers. When
remaining requests drop to ≤ 10, pauses until the rate-limit window resets.

Requires a GitHub token via `GITHUB_TOKEN` or `--token`.
Flags: `--concurrency` (default 2), `--delay` (default 500ms), `--force`,
`--db` (default `~/.elm-docs/elm-packages.db`).

-}

import BackendTask exposing (BackendTask)
import BackendTask.Custom
import BackendTask.Env
import BackendTask.Http
import BackendTask.Time
import Cli.Option as Option
import Cli.OptionsParser as OptionsParser exposing (with)
import Cli.Program as Program
import Dict
import FatalError exposing (FatalError)
import Iso8601
import Json.Decode as Decode
import Json.Encode as Encode
import Pages.Script as Script exposing (Script)
import Shared.Ansi exposing (dim, green, red)
import Shared.CliHelpers exposing (parseIntOpt)
import SyncGithub.DateStats as DateStats exposing (DateStats, IssueInfo)
import SyncGithub.ErrorClassification as ErrorClassification
import Time


type alias CliOptions =
    { concurrency : Int
    , delay : Int
    , force : Bool
    , token : Maybe String
    , limit : Maybe Int
    , db : String
    }


type alias PackageId =
    { org : String
    , name : String
    }


run : Script
run =
    Script.withCliOptions programConfig
        (\options ->
            resolveToken options.token
                |> BackendTask.andThen
                    (\token ->
                        initDb options.db
                            |> BackendTask.andThen (\() -> Script.log (dim "[syncGithub]" ++ " Starting GitHub metadata sync"))
                            |> BackendTask.andThen
                                (\() ->
                                    if options.force then
                                        Script.log (dim "[syncGithub]" ++ " --force: re-fetching all packages")

                                    else
                                        BackendTask.succeed ()
                                )
                            |> BackendTask.andThen (\() -> discoverAndFetch token options)
                            |> BackendTask.andThen (\() -> computeRanks options.db)
                            |> BackendTask.andThen (\() -> Script.log (dim "[syncGithub]" ++ " Done"))
                    )
        )


programConfig : Program.Config CliOptions
programConfig =
    Program.config
        |> Program.add
            (OptionsParser.build CliOptions
                |> with
                    (Option.optionalKeywordArg "concurrency"
                        |> Option.validateMap (parseIntOpt "concurrency" 2)
                    )
                |> with
                    (Option.optionalKeywordArg "delay"
                        |> Option.validateMap (parseIntOpt "delay" 500)
                    )
                |> with (Option.flag "force")
                |> with (Option.optionalKeywordArg "token")
                |> with
                    (Option.optionalKeywordArg "limit"
                        |> Option.validateMap parseLimit
                    )
                |> with
                    (Option.optionalKeywordArg "db"
                        |> Option.withDefault "~/.elm-docs/elm-packages.db"
                    )
            )


parseLimit : Maybe String -> Result String (Maybe Int)
parseLimit maybeStr =
    case maybeStr of
        Nothing ->
            Ok Nothing

        Just str ->
            case String.toInt str of
                Just n ->
                    if n > 0 then
                        Ok (Just n)

                    else
                        Err ("--limit must be positive, got: " ++ str)

                Nothing ->
                    Err ("Invalid --limit value: " ++ str)


resolveToken : Maybe String -> BackendTask FatalError String
resolveToken maybeToken =
    case maybeToken of
        Just t ->
            BackendTask.succeed t

        Nothing ->
            BackendTask.Env.get "GITHUB_TOKEN"
                |> BackendTask.andThen
                    (\maybeEnv ->
                        case maybeEnv of
                            Just t ->
                                BackendTask.succeed t

                            Nothing ->
                                BackendTask.fail
                                    (FatalError.build
                                        { title = "GitHub token required"
                                        , body = "Set GITHUB_TOKEN env var or pass --token."
                                        }
                                    )
                    )



-- Discovery


discoverAndFetch : String -> CliOptions -> BackendTask FatalError ()
discoverAndFetch token options =
    getPackagesForGithubSync options.db options.force
        |> BackendTask.andThen
            (\allToFetch ->
                let
                    toFetch : List PackageId
                    toFetch =
                        case options.limit of
                            Just n ->
                                List.take n allToFetch

                            Nothing ->
                                allToFetch

                    total : Int
                    total =
                        List.length toFetch

                    limitNote : String
                    limitNote =
                        case options.limit of
                            Just n ->
                                let
                                    allCount : Int
                                    allCount =
                                        List.length allToFetch
                                in
                                if allCount > n then
                                    " (limited from " ++ String.fromInt allCount ++ ")"

                                else
                                    ""

                            Nothing ->
                                ""
                in
                Script.log (dim "[syncGithub]" ++ " " ++ String.fromInt total ++ " package(s) need GitHub info" ++ limitNote)
                    |> BackendTask.andThen (\() -> fetchAll token options toFetch)
            )



-- Fetch all


type alias FetchProgress =
    { completed : Int
    , failed : Int
    , total : Int
    , failures : List PackageId
    }


fetchAll : String -> CliOptions -> List PackageId -> BackendTask FatalError ()
fetchAll token options packages =
    let
        total : Int
        total =
            List.length packages
    in
    Script.log (dim "[fetch]" ++ " " ++ String.fromInt total ++ " package(s) to fetch (concurrency: " ++ String.fromInt options.concurrency ++ ", delay: " ++ String.fromInt options.delay ++ "ms)")
        |> BackendTask.andThen
            (\() ->
                if total == 0 then
                    BackendTask.succeed ()

                else
                    let
                        batches : List (List PackageId)
                        batches =
                            chunk options.concurrency packages
                    in
                    processBatches token options batches { completed = 0, failed = 0, total = total, failures = [] }
                        |> BackendTask.andThen
                            (\result ->
                                Script.log (dim "[fetch]" ++ " Completed: " ++ green (String.fromInt result.completed) ++ " succeeded, " ++ red (String.fromInt result.failed) ++ " failed")
                                    |> BackendTask.andThen
                                        (\() ->
                                            if List.isEmpty result.failures then
                                                BackendTask.succeed ()

                                            else
                                                Script.log (formatFailures result.failures)
                                        )
                            )
            )


processBatches : String -> CliOptions -> List (List PackageId) -> FetchProgress -> BackendTask FatalError FetchProgress
processBatches token options batches progress =
    case batches of
        [] ->
            BackendTask.succeed progress

        batch :: rest ->
            BackendTask.combine (List.map (fetchOne token options.db) batch)
                |> BackendTask.andThen
                    (\results ->
                        let
                            newProgress : FetchProgress
                            newProgress =
                                List.foldl
                                    (\result acc ->
                                        if result.ok then
                                            { acc | completed = acc.completed + 1 }

                                        else
                                            { acc | failed = acc.failed + 1, failures = result.pkg :: acc.failures }
                                    )
                                    progress
                                    results

                            done : Int
                            done =
                                newProgress.completed + newProgress.failed

                            pct : String
                            pct =
                                if newProgress.total > 0 then
                                    String.fromInt (done * 100 // newProgress.total)

                                else
                                    "0"
                        in
                        Script.log (dim "[fetch]" ++ " Progress: " ++ String.fromInt done ++ "/" ++ String.fromInt newProgress.total ++ dim (" (" ++ pct ++ "%)") ++ " (" ++ String.fromInt newProgress.failed ++ " errors)")
                            |> BackendTask.andThen
                                (\() ->
                                    if options.delay > 0 && not (List.isEmpty rest) then
                                        Script.sleep options.delay
                                            |> BackendTask.andThen (\() -> processBatches token options rest newProgress)

                                    else
                                        processBatches token options rest newProgress
                                )
                    )


type alias FetchResult =
    { ok : Bool, pkg : PackageId }


fetchOne : String -> String -> PackageId -> BackendTask FatalError FetchResult
fetchOne token dbPath pkg =
    BackendTask.Time.now
        |> BackendTask.andThen (\now -> fetchGithubInfo token now pkg.org pkg.name)
        |> BackendTask.andThen
            (\result ->
                let
                    ( resultType, data ) =
                        githubResultToTypeAndData result
                in
                upsertGithubResult dbPath pkg.org pkg.name resultType data
                    |> BackendTask.map (\() -> { ok = True, pkg = pkg })
            )
        |> BackendTask.onError
            (\_ ->
                recordGithubError dbPath pkg.org pkg.name "GitHub API error"
                    |> BackendTask.map (\() -> { ok = False, pkg = pkg })
            )


type GithubResult
    = Info String
    | Redirect String
    | Missing String


githubResultToTypeAndData : GithubResult -> ( String, String )
githubResultToTypeAndData result =
    case result of
        Info data ->
            ( "info", data )

        Redirect data ->
            ( "redirect", data )

        Missing data ->
            ( "missing", data )



-- GitHub API


githubApi : String
githubApi =
    "https://api.github.com"


githubRequest :
    String
    -> String
    -> BackendTask.Http.Expect a
    -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } a
githubRequest token path expect =
    BackendTask.Http.request
        { url = githubApi ++ path
        , method = "GET"
        , headers =
            [ ( "Accept", "application/vnd.github+json" )
            , ( "Authorization", "Bearer " ++ token )
            , ( "X-GitHub-Api-Version", "2022-11-28" )
            ]
        , body = BackendTask.Http.emptyBody
        , retries = Nothing
        , timeoutInMs = Just 30000
        }
        expect


type RepoStep
    = EarlyResult GithubResult
    | RepoData ( String, Int )


fetchGithubInfo : String -> Time.Posix -> String -> String -> BackendTask FatalError GithubResult
fetchGithubInfo token now org pkg =
    githubRequest token
        ("/repos/" ++ org ++ "/" ++ pkg)
        (BackendTask.Http.withMetadata Tuple.pair
            (BackendTask.Http.expectJson
                (Decode.map2 Tuple.pair
                    (Decode.field "full_name" Decode.string)
                    (Decode.field "stargazers_count" Decode.int)
                )
            )
        )
        |> BackendTask.map (\( _, repoData ) -> RepoData repoData)
        |> BackendTask.onError
            (\{ recoverable } ->
                case recoverable of
                    BackendTask.Http.BadStatus metadata _ ->
                        if metadata.statusCode == 404 then
                            fetchUserExists token org
                                |> BackendTask.map
                                    (\( userExists, userType ) ->
                                        let
                                            data : String
                                            data =
                                                Encode.encode 2
                                                    (Encode.object
                                                        [ ( "fetched_at", Encode.string (Iso8601.fromTime now) )
                                                        , ( "repo", Encode.string (org ++ "/" ++ pkg) )
                                                        , ( "user_exists", Encode.bool userExists )
                                                        , ( "user_type"
                                                          , case userType of
                                                                Just t ->
                                                                    Encode.string t

                                                                Nothing ->
                                                                    Encode.null
                                                          )
                                                        ]
                                                    )
                                        in
                                        EarlyResult (Missing data)
                                    )

                        else
                            let
                                reason : ErrorClassification.ErrorReason
                                reason =
                                    ErrorClassification.classifyResponse metadata.statusCode
                                        (Dict.get "message" metadata.headers |> Maybe.withDefault "")

                                errMsg : String
                                errMsg =
                                    "HTTP " ++ String.fromInt metadata.statusCode ++ " " ++ metadata.statusText
                            in
                            BackendTask.fail
                                (FatalError.build
                                    { title = "GitHub API error"
                                    , body = ErrorClassification.reasonToString reason ++ ": " ++ errMsg
                                    }
                                )

                    _ ->
                        BackendTask.fail
                            (FatalError.build
                                { title = "GitHub API error"
                                , body = httpErrorToString recoverable
                                }
                            )
            )
        |> BackendTask.andThen
            (\step ->
                case step of
                    EarlyResult result ->
                        BackendTask.succeed result

                    RepoData ( fullName, starsCount ) ->
                        let
                            originalRepo : String
                            originalRepo =
                                org ++ "/" ++ pkg
                        in
                        if String.toLower fullName /= String.toLower originalRepo then
                            let
                                parts : List String
                                parts =
                                    String.split "/" fullName

                                ( newOrg, newName ) =
                                    case parts of
                                        o :: n :: _ ->
                                            ( o, n )

                                        _ ->
                                            ( fullName, "" )

                                data : String
                                data =
                                    Encode.encode 2
                                        (Encode.object
                                            [ ( "fetched_at", Encode.string (Iso8601.fromTime now) )
                                            , ( "original_repo", Encode.string originalRepo )
                                            , ( "redirected_to", Encode.string fullName )
                                            , ( "new_org", Encode.string newOrg )
                                            , ( "new_name", Encode.string newName )
                                            ]
                                        )
                            in
                            BackendTask.succeed (Redirect data)

                        else
                            fetchRepoDetails token now org pkg starsCount
            )


fetchUserExists : String -> String -> BackendTask FatalError ( Bool, Maybe String )
fetchUserExists token org =
    githubRequest token
        ("/users/" ++ org)
        (BackendTask.Http.expectJson (Decode.field "type" Decode.string))
        |> BackendTask.map (\userType -> ( True, Just userType ))
        |> BackendTask.onError (\_ -> BackendTask.succeed ( False, Nothing ))


fetchRepoDetails : String -> Time.Posix -> String -> String -> Int -> BackendTask FatalError GithubResult
fetchRepoDetails token now org pkg starsCount =
    BackendTask.map3
        (\lastCommitAt maintainers allIssues ->
            ( lastCommitAt, maintainers, allIssues )
        )
        (fetchLastCommit token org pkg)
        (fetchMaintainers token org pkg)
        (fetchAllIssues token org pkg)
        |> BackendTask.andThen
            (\( lastCommitAt, maintainers, allIssues ) ->
                let
                    rawIssues : List RawIssue
                    rawIssues =
                        List.filter (\i -> not i.hasPr) allIssues

                    rawPrs : List RawIssue
                    rawPrs =
                        List.filter .hasPr allIssues
                in
                BackendTask.map2 Tuple.pair
                    (BackendTask.combine (List.map (enrichIssue token org pkg maintainers) rawIssues))
                    (BackendTask.combine (List.map (enrichIssue token org pkg maintainers) rawPrs))
                    |> BackendTask.map
                        (\( issues, prs ) ->
                            let
                                openIssues : DateStats
                                openIssues =
                                    DateStats.computeDateStats now issues

                                openPrs : DateStats
                                openPrs =
                                    DateStats.computeDateStats now prs

                                data : String
                                data =
                                    Encode.encode 2
                                        (Encode.object
                                            [ ( "fetched_at", Encode.string (Iso8601.fromTime now) )
                                            , ( "stargazers_count", Encode.int starsCount )
                                            , ( "last_commit_at"
                                              , case lastCommitAt of
                                                    Just d ->
                                                        Encode.string d

                                                    Nothing ->
                                                        Encode.null
                                              )
                                            , ( "open_issues", encodeDateStats openIssues )
                                            , ( "open_prs", encodeDateStats openPrs )
                                            ]
                                        )
                            in
                            Info data
                        )
            )
        |> BackendTask.allowFatal


type alias RawIssue =
    { number : Int, createdAt : String, hasPr : Bool }


fetchLastCommit : String -> String -> String -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } (Maybe String)
fetchLastCommit token org pkg =
    githubRequest token
        ("/repos/" ++ org ++ "/" ++ pkg ++ "/commits?per_page=1")
        (BackendTask.Http.expectJson
            (Decode.list
                (Decode.at [ "commit", "committer", "date" ] Decode.string)
            )
        )
        |> BackendTask.map List.head
        |> BackendTask.onError (\_ -> BackendTask.succeed Nothing)


fetchMaintainers : String -> String -> String -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } (List String)
fetchMaintainers token org pkg =
    githubRequest token
        ("/repos/" ++ org ++ "/" ++ pkg ++ "/collaborators?affiliation=direct&per_page=100")
        (BackendTask.Http.expectJson
            (Decode.list
                (Decode.map2 Tuple.pair
                    (Decode.field "login" Decode.string)
                    (Decode.field "permissions"
                        (Decode.map3 (\a m p -> a || m || p)
                            (Decode.oneOf [ Decode.field "admin" Decode.bool, Decode.succeed False ])
                            (Decode.oneOf [ Decode.field "maintain" Decode.bool, Decode.succeed False ])
                            (Decode.oneOf [ Decode.field "push" Decode.bool, Decode.succeed False ])
                        )
                    )
                )
            )
        )
        |> BackendTask.map
            (List.filterMap
                (\( login, hasPerm ) ->
                    if hasPerm then
                        Just login

                    else
                        Nothing
                )
            )
        |> BackendTask.onError (\_ -> BackendTask.succeed [])


fetchAllIssues : String -> String -> String -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } (List RawIssue)
fetchAllIssues token org pkg =
    fetchAllPages token
        ("/repos/" ++ org ++ "/" ++ pkg ++ "/issues?state=open")
        (Decode.list
            (Decode.map3 RawIssue
                (Decode.field "number" Decode.int)
                (Decode.field "created_at" Decode.string)
                (Decode.map ((/=) Nothing) (Decode.maybe (Decode.field "pull_request" Decode.value)))
            )
        )


fetchAllPages :
    String
    -> String
    -> Decode.Decoder (List a)
    -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } (List a)
fetchAllPages token path decoder =
    let
        url : String
        url =
            githubApi ++ path
                ++ (if String.contains "?" path then
                        "&"

                    else
                        "?"
                   )
                ++ "per_page=100"
    in
    fetchPage token url decoder []


fetchPage :
    String
    -> String
    -> Decode.Decoder (List a)
    -> List a
    -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } (List a)
fetchPage token url decoder accumulated =
    BackendTask.Http.request
        { url = url
        , method = "GET"
        , headers =
            [ ( "Accept", "application/vnd.github+json" )
            , ( "Authorization", "Bearer " ++ token )
            , ( "X-GitHub-Api-Version", "2022-11-28" )
            ]
        , body = BackendTask.Http.emptyBody
        , retries = Nothing
        , timeoutInMs = Just 30000
        }
        (BackendTask.Http.withMetadata Tuple.pair (BackendTask.Http.expectJson decoder))
        |> BackendTask.andThen
            (\( metadata, items ) ->
                let
                    allItems : List a
                    allItems =
                        accumulated ++ items

                    nextUrl : Maybe String
                    nextUrl =
                        parseNextLink (Dict.get "link" metadata.headers)
                in
                case nextUrl of
                    Just next ->
                        fetchPage token next decoder allItems

                    Nothing ->
                        BackendTask.succeed allItems
            )


parseNextLink : Maybe String -> Maybe String
parseNextLink maybeLinkHeader =
    case maybeLinkHeader of
        Nothing ->
            Nothing

        Just linkHeader ->
            linkHeader
                |> String.split ","
                |> List.filterMap
                    (\part ->
                        let
                            trimmed : String
                            trimmed =
                                String.trim part

                            segments : List String
                            segments =
                                String.split ";" trimmed
                        in
                        case segments of
                            urlPart :: relPart :: _ ->
                                if String.contains "rel=\"next\"" (String.trim relPart) then
                                    Just (String.trim (String.slice 1 -1 (String.trim urlPart)))

                                else
                                    Nothing

                            _ ->
                                Nothing
                    )
                |> List.head


enrichIssue :
    String
    -> String
    -> String
    -> List String
    -> RawIssue
    -> BackendTask { fatal : FatalError, recoverable : BackendTask.Http.Error } IssueInfo
enrichIssue token org pkg maintainers rawIssue =
    githubRequest token
        ("/repos/" ++ org ++ "/" ++ pkg ++ "/issues/" ++ String.fromInt rawIssue.number ++ "/comments?per_page=1&sort=created&direction=desc")
        (BackendTask.Http.expectJson
            (Decode.list
                (Decode.map2 Tuple.pair
                    (Decode.field "created_at" Decode.string)
                    (Decode.maybe (Decode.at [ "user", "login" ] Decode.string))
                )
            )
        )
        |> BackendTask.map
            (\comments ->
                case comments of
                    ( commentAt, maybeLogin ) :: _ ->
                        { number = rawIssue.number
                        , createdAt = rawIssue.createdAt
                        , lastCommentAt = Just commentAt
                        , lastCommentByMaintainer = Maybe.map (\login -> List.member login maintainers) maybeLogin
                        }

                    [] ->
                        { number = rawIssue.number
                        , createdAt = rawIssue.createdAt
                        , lastCommentAt = Nothing
                        , lastCommentByMaintainer = Nothing
                        }
            )
        |> BackendTask.onError
            (\_ ->
                BackendTask.succeed
                    { number = rawIssue.number
                    , createdAt = rawIssue.createdAt
                    , lastCommentAt = Nothing
                    , lastCommentByMaintainer = Nothing
                    }
            )



-- Compute ranks


computeRanks : String -> BackendTask FatalError ()
computeRanks dbPath =
    computePackageRanks dbPath
        |> BackendTask.andThen
            (\count ->
                Script.log (green ("  " ++ String.fromInt count ++ " package ranks computed"))
            )



-- Encoding


encodeDateStats : DateStats -> Encode.Value
encodeDateStats stats =
    Encode.object
        [ ( "count", Encode.int stats.count )
        , ( "min_days", Encode.int stats.minDays )
        , ( "max_days", Encode.int stats.maxDays )
        , ( "avg_days", Encode.int stats.avgDays )
        , ( "items", Encode.list encodeIssueInfo stats.items )
        ]


encodeIssueInfo : IssueInfo -> Encode.Value
encodeIssueInfo item =
    Encode.object
        [ ( "number", Encode.int item.number )
        , ( "created_at", Encode.string item.createdAt )
        , ( "last_comment_at"
          , case item.lastCommentAt of
                Just d ->
                    Encode.string d

                Nothing ->
                    Encode.null
          )
        , ( "last_comment_by_maintainer"
          , case item.lastCommentByMaintainer of
                Just b ->
                    Encode.bool b

                Nothing ->
                    Encode.null
          )
        ]



-- FFI Calls


initDb : String -> BackendTask FatalError ()
initDb dbPath =
    BackendTask.Custom.run "initDb"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "full", Encode.bool False )
            ]
        )
        (Decode.succeed ())
        |> BackendTask.allowFatal


getPackagesForGithubSync : String -> Bool -> BackendTask FatalError (List PackageId)
getPackagesForGithubSync dbPath force =
    BackendTask.Custom.run "getPackagesForGithubSync"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "force", Encode.bool force )
            ]
        )
        (Decode.list
            (Decode.map2 PackageId
                (Decode.field "org" Decode.string)
                (Decode.field "name" Decode.string)
            )
        )
        |> BackendTask.allowFatal


upsertGithubResult : String -> String -> String -> String -> String -> BackendTask FatalError ()
upsertGithubResult dbPath org name resultType data =
    BackendTask.Custom.run "upsertGithubResult"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "org", Encode.string org )
            , ( "name", Encode.string name )
            , ( "resultType", Encode.string resultType )
            , ( "data", Encode.string data )
            ]
        )
        (Decode.succeed ())
        |> BackendTask.allowFatal


recordGithubError : String -> String -> String -> String -> BackendTask FatalError ()
recordGithubError dbPath org name error =
    BackendTask.Custom.run "recordGithubError"
        (Encode.object
            [ ( "dbPath", Encode.string dbPath )
            , ( "org", Encode.string org )
            , ( "name", Encode.string name )
            , ( "error", Encode.string error )
            ]
        )
        (Decode.succeed ())
        |> BackendTask.allowFatal


computePackageRanks : String -> BackendTask FatalError Int
computePackageRanks dbPath =
    BackendTask.Custom.run "computePackageRanks"
        (Encode.object [ ( "dbPath", Encode.string dbPath ) ])
        (Decode.field "count" Decode.int)
        |> BackendTask.allowFatal



-- Helpers


chunk : Int -> List a -> List (List a)
chunk size list =
    if size <= 0 || List.isEmpty list then
        []

    else
        List.take size list :: chunk size (List.drop size list)


formatFailures : List PackageId -> String
formatFailures failures =
    let
        header : String
        header =
            "\n" ++ red "Packages with errors:"

        shown : List PackageId
        shown =
            List.take 5 failures

        items : List String
        items =
            List.map (\p -> "  " ++ dim "•" ++ " " ++ p.org ++ "/" ++ p.name) shown

        remaining : Int
        remaining =
            List.length failures - List.length shown
    in
    if remaining > 0 then
        String.join "\n" (header :: items ++ [ dim ("  … and " ++ String.fromInt remaining ++ " more") ])

    else
        String.join "\n" (header :: items)


httpErrorToString : BackendTask.Http.Error -> String
httpErrorToString err =
    case err of
        BackendTask.Http.BadUrl u ->
            "BadUrl: " ++ u

        BackendTask.Http.Timeout ->
            "Timeout"

        BackendTask.Http.NetworkError ->
            "Network Error"

        BackendTask.Http.BadStatus meta _ ->
            "HTTP " ++ String.fromInt meta.statusCode ++ " " ++ meta.statusText

        BackendTask.Http.BadBody _ msg ->
            "Bad Body: " ++ msg
