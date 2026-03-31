module BuildDb.TypeIndex exposing (ProcessResult, TypeEntry, TypeIndexRow, processEntries)

{-| Build-phase type indexing.

For each package's latest version, processes every value, alias, and binop:

1.  Parse the type string into an AST
2.  Normalize type variables to canonical names (a, b, c, …)
3.  Generate a structural fingerprint for pre-filtering
4.  Store the AST, fingerprint, and metadata in the `type_index` table (~217K rows)

The build is incremental — only packages with new versions are re-indexed.

-}

import Json.Encode as Encode
import TypeSearch.Fingerprint as Fingerprint
import TypeSearch.Normalize as Normalize
import TypeSearch.Parse as Parse
import TypeSearch.Type as Type


type alias TypeEntry =
    { moduleName : String
    , name : String
    , kind : String
    , typeRaw : String
    }


type alias TypeIndexRow =
    { packageId : Int
    , versionId : Int
    , moduleName : String
    , name : String
    , kind : String
    , typeRaw : String
    , typeAstJson : String
    , fingerprint : String
    , argCount : Int
    }


type alias ProcessResult =
    { rows : List TypeIndexRow
    , parseErrors : Int
    }


processEntries : Int -> Int -> List TypeEntry -> ProcessResult
processEntries packageId versionId entries =
    List.foldl (processEntry packageId versionId) { rows = [], parseErrors = 0 } entries
        |> (\r -> { r | rows = List.reverse r.rows })


processEntry : Int -> Int -> TypeEntry -> ProcessResult -> ProcessResult
processEntry packageId versionId entry acc =
    case Parse.parseLenient entry.typeRaw of
        Err _ ->
            { acc | parseErrors = acc.parseErrors + 1 }

        Ok parsed ->
            let
                normalized : Type.Type
                normalized =
                    Normalize.normalize parsed

                fp : String
                fp =
                    Fingerprint.fingerprint normalized

                argCount : Int
                argCount =
                    Fingerprint.countArgs normalized

                astJson : String
                astJson =
                    Type.encoder normalized
                        |> Encode.encode 0

                row : TypeIndexRow
                row =
                    { packageId = packageId
                    , versionId = versionId
                    , moduleName = entry.moduleName
                    , name = entry.name
                    , kind = entry.kind
                    , typeRaw = entry.typeRaw
                    , typeAstJson = astJson
                    , fingerprint = fp
                    , argCount = argCount
                    }
            in
            { acc | rows = row :: acc.rows }
