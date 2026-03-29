module ProjectContext.ProjectPathTest exposing (suite)

import Expect
import ProjectContext.ProjectPath as ProjectPath
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "ProjectContext.ProjectPath"
        [ test "same homeDir and hash give same DB path (deterministic)" <|
            \() ->
                let
                    path1 : String
                    path1 =
                        ProjectPath.dbPath "~" "abc1234567890abc"

                    path2 : String
                    path2 =
                        ProjectPath.dbPath "~" "abc1234567890abc"
                in
                path1 |> Expect.equal path2
        , test "different hashes give different DB paths" <|
            \() ->
                let
                    path1 : String
                    path1 =
                        ProjectPath.dbPath "~" "abc1234567890abc"

                    path2 : String
                    path2 =
                        ProjectPath.dbPath "~" "def4567890defabc"
                in
                (path1 /= path2) |> Expect.equal True
        , test "DB path ends in /context.db" <|
            \() ->
                ProjectPath.dbPath "~" "abc1234567890abc"
                    |> String.endsWith "/context.db"
                    |> Expect.equal True
        , test "DB path contains /.elm-docs/projects/" <|
            \() ->
                ProjectPath.dbPath "~" "abc1234567890abc"
                    |> String.contains "/.elm-docs/projects/"
                    |> Expect.equal True
        ]
