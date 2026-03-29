module ProjectContext.ElmJson exposing (ProjectInfo, ProjectType(..), decoder, directDeps)

import Json.Decode as Decode


type ProjectType
    = Application
    | Package


type alias ProjectInfo =
    { projectType : ProjectType
    , name : String
    , version : String
    , directDeps : List String
    , sourceDirs : List String
    }


decoder : Decode.Decoder ProjectInfo
decoder =
    Decode.map5 ProjectInfo
        (Decode.field "projectType" projectTypeDecoder)
        (Decode.field "name" Decode.string)
        (Decode.field "version" Decode.string)
        (Decode.field "directDeps" (Decode.list Decode.string))
        (Decode.field "sourceDirs" (Decode.list Decode.string))


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


directDeps : ProjectInfo -> List String
directDeps info =
    info.directDeps
