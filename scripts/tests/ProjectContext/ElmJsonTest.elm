module ProjectContext.ElmJsonTest exposing (suite)

import Expect
import Json.Decode as Decode
import ProjectContext.ElmJson as ElmJson exposing (ProjectType(..))
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "ProjectContext.ElmJson"
        [ test "decodes application elm.json response" <|
            \() ->
                let
                    json : String
                    json =
                        """{"projectType":"application","name":"local/app","version":"1.0.0","directDeps":[{"name":"elm/core","majorVersion":1},{"name":"elm/html","majorVersion":1}],"sourceDirs":["/path/src"]}"""
                in
                case Decode.decodeString ElmJson.decoder json of
                    Ok info ->
                        Expect.all
                            [ \i -> i.projectType |> Expect.equal Application
                            , \i -> i.directDeps |> Expect.equal [ { name = "elm/core", majorVersion = 1 }, { name = "elm/html", majorVersion = 1 } ]
                            , \i -> i.sourceDirs |> Expect.equal [ "/path/src" ]
                            ]
                            info

                    Err e ->
                        Expect.fail (Decode.errorToString e)
        , test "decodes package elm.json response" <|
            \() ->
                let
                    json : String
                    json =
                        """{"projectType":"package","name":"author/pkg","version":"1.2.3","directDeps":[{"name":"elm/core","majorVersion":1}],"sourceDirs":["/path/src"]}"""
                in
                case Decode.decodeString ElmJson.decoder json of
                    Ok info ->
                        Expect.all
                            [ \i -> i.projectType |> Expect.equal Package
                            , \i -> i.version |> Expect.equal "1.2.3"
                            , \i -> i.name |> Expect.equal "author/pkg"
                            ]
                            info

                    Err e ->
                        Expect.fail (Decode.errorToString e)
        , test "directDeps returns only direct deps" <|
            \() ->
                let
                    json : String
                    json =
                        """{"projectType":"application","name":"local/app","version":"1.0.0","directDeps":[{"name":"elm/core","majorVersion":1},{"name":"elm/html","majorVersion":1}],"sourceDirs":["src"]}"""
                in
                case Decode.decodeString ElmJson.decoder json of
                    Ok info ->
                        ElmJson.directDeps info
                            |> Expect.equal [ { name = "elm/core", majorVersion = 1 }, { name = "elm/html", majorVersion = 1 } ]

                    Err e ->
                        Expect.fail (Decode.errorToString e)
        , test "unknown project type returns Err" <|
            \() ->
                let
                    json : String
                    json =
                        """{"projectType":"unknown","name":"local/app","version":"1.0.0","directDeps":[],"sourceDirs":["src"]}"""
                in
                Decode.decodeString ElmJson.decoder json
                    |> Result.toMaybe
                    |> Expect.equal Nothing
        , test "missing sourceDirs returns Err" <|
            \() ->
                let
                    json : String
                    json =
                        """{"projectType":"application","name":"local/app","version":"1.0.0","directDeps":[]}"""
                in
                Decode.decodeString ElmJson.decoder json
                    |> Result.toMaybe
                    |> Expect.equal Nothing
        ]
