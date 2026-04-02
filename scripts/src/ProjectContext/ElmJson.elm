module ProjectContext.ElmJson exposing (DirectDep, ProjectInfo, ProjectType(..), decoder, directDeps)

{-| Decodes elm.json project metadata for project-scoped searches.
-}

import Json.Decode as Decode


type ProjectType
    = Application
    | Package


type alias DirectDep =
    { name : String
    , majorVersion : Int
    }


type alias ProjectInfo =
    { projectType : ProjectType
    , name : String
    , version : String
    , directDeps : List DirectDep
    , sourceDirs : List String
    }


decoder : Decode.Decoder ProjectInfo
decoder =
    Decode.map5 ProjectInfo
        (Decode.field "projectType" projectTypeDecoder)
        (Decode.field "name" Decode.string)
        (Decode.field "version" Decode.string)
        (Decode.field "directDeps" (Decode.list directDepDecoder))
        (Decode.field "sourceDirs" (Decode.list Decode.string))


directDepDecoder : Decode.Decoder DirectDep
directDepDecoder =
    Decode.map2 DirectDep
        (Decode.field "name" Decode.string)
        (Decode.field "majorVersion" Decode.int)


projectTypeDecoder : Decode.Decoder ProjectType
projectTypeDecoder =
    Decode.string
        |> Decode.andThen
            (\s ->
                case s of
                    "application" ->
                        Decode.succeed Application

                    "package" ->
                        Decode.succeed Package

                    _ ->
                        Decode.fail ("Unknown project type: " ++ s)
            )


directDeps : ProjectInfo -> List DirectDep
directDeps info =
    info.directDeps
