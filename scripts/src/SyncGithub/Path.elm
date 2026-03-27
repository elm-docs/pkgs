module SyncGithub.Path exposing
    ( toGithubErrorsPath
    , toGithubInfoPath
    , toGithubMissingPath
    , toGithubRedirectPath
    , toPackageDir
    , toPackageKey
    )

import Sync.Path as SyncPath


toPackageDir : String -> String -> String
toPackageDir org pkg =
    SyncPath.contentDir ++ "/" ++ org ++ "/" ++ pkg


toGithubInfoPath : String -> String -> String
toGithubInfoPath org pkg =
    toPackageDir org pkg ++ "/github.json"


toGithubRedirectPath : String -> String -> String
toGithubRedirectPath org pkg =
    toPackageDir org pkg ++ "/github-redirect.json"


toGithubMissingPath : String -> String -> String
toGithubMissingPath org pkg =
    toPackageDir org pkg ++ "/github-missing.json"


toGithubErrorsPath : String -> String -> String
toGithubErrorsPath org pkg =
    toPackageDir org pkg ++ "/github-errors.json"


toPackageKey : String -> String -> String
toPackageKey org pkg =
    org ++ "/" ++ pkg
