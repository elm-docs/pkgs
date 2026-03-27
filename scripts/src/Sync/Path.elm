module Sync.Path exposing (contentDir, toDocsPath, toDocsUrl, toErrorsPath, toPendingPath, toVersionDir)

import Shared.PackageVersion as PackageVersion exposing (PackageVersion)


contentDir : String
contentDir =
    "../package-elm-lang-org/content/packages"


toVersionDir : PackageVersion -> String
toVersionDir pv =
    contentDir ++ "/" ++ PackageVersion.org pv ++ "/" ++ PackageVersion.pkg pv ++ "/" ++ PackageVersion.version pv


toDocsUrl : PackageVersion -> String
toDocsUrl pv =
    "https://package.elm-lang.org/packages/"
        ++ PackageVersion.org pv
        ++ "/"
        ++ PackageVersion.pkg pv
        ++ "/"
        ++ PackageVersion.version pv
        ++ "/docs.json"


toDocsPath : PackageVersion -> String
toDocsPath pv =
    toVersionDir pv ++ "/docs.json"


toErrorsPath : PackageVersion -> String
toErrorsPath pv =
    toVersionDir pv ++ "/errors.json"


toPendingPath : PackageVersion -> String
toPendingPath pv =
    toVersionDir pv ++ "/pending"
