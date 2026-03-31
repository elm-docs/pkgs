module Shared.PackageVersion exposing
    ( PackageVersion
    , fromString
    , org
    , pkg
    , toKey
    , toLabel
    , version
    )

{-| Opaque type representing an org/package@version triple.
-}

type PackageVersion
    = PackageVersion
        { org : String
        , pkg : String
        , version : String
        }


fromString : String -> Maybe PackageVersion
fromString raw =
    case String.split "@" raw of
        [ orgPkg, ver ] ->
            if ver == "" then
                Nothing

            else
                case String.split "/" orgPkg of
                    [ o, p ] ->
                        if o == "" || p == "" then
                            Nothing

                        else
                            Just
                                (PackageVersion
                                    { org = o
                                    , pkg = p
                                    , version = ver
                                    }
                                )

                    _ ->
                        Nothing

        _ ->
            Nothing


toKey : PackageVersion -> String
toKey (PackageVersion pv) =
    pv.org ++ "/" ++ pv.pkg ++ "@" ++ pv.version


toLabel : PackageVersion -> String
toLabel =
    toKey


org : PackageVersion -> String
org (PackageVersion pv) =
    pv.org


pkg : PackageVersion -> String
pkg (PackageVersion pv) =
    pv.pkg


version : PackageVersion -> String
version (PackageVersion pv) =
    pv.version
