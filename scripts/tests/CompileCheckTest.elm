module CompileCheckTest exposing (suite)

{-| Forces the compiler to type-check all script entry points.

These modules are otherwise only compiled at runtime via `elm-pages run`,
so type errors can slip through to CI undetected.
-}

import BuildProjectContext
import Expect
import Status
import Sync
import SyncElmPackages
import SyncGithub
import Test exposing (Test, describe, test)
import TextSearch
import TypeSearch


suite : Test
suite =
    describe "Compile check"
        [ test "all script entry points type-check" <|
            \() ->
                let
                    _ =
                        ( BuildProjectContext.run
                        , Status.run
                        , Sync.run
                        )

                    _ =
                        ( SyncElmPackages.run
                        , SyncGithub.run
                        , TextSearch.run
                        )

                    _ =
                        TypeSearch.run
                in
                Expect.pass
        ]
