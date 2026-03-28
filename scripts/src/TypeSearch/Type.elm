module TypeSearch.Type exposing
    ( QualifiedName
    , Type(..)
    , decoder
    )

import Json.Decode as Decode exposing (Decoder)


type Type
    = Fn (List Type) Type
    | Var String
    | App QualifiedName (List Type)
    | Tuple (List Type)
    | Record (List ( String, Type )) (Maybe String)


type alias QualifiedName =
    { home : String, name : String }



-- JSON DECODER (for type_ast column from DB)


decoder : Decoder Type
decoder =
    Decode.field "tag" Decode.string
        |> Decode.andThen tagDecoder


tagDecoder : String -> Decoder Type
tagDecoder tag =
    case tag of
        "fn" ->
            Decode.map2 Fn
                (Decode.field "args" (Decode.list (Decode.lazy (\() -> decoder))))
                (Decode.field "result" (Decode.lazy (\() -> decoder)))

        "var" ->
            Decode.map Var
                (Decode.field "name" Decode.string)

        "app" ->
            Decode.map2 App
                (Decode.field "name" qualifiedNameDecoder)
                (Decode.field "args" (Decode.list (Decode.lazy (\() -> decoder))))

        "tuple" ->
            Decode.map Tuple
                (Decode.field "args" (Decode.list (Decode.lazy (\() -> decoder))))

        "record" ->
            Decode.map2 Record
                (Decode.field "fields" (Decode.list fieldDecoder))
                (Decode.field "ext" (Decode.nullable Decode.string))

        _ ->
            Decode.fail ("Unknown type tag: " ++ tag)


qualifiedNameDecoder : Decoder QualifiedName
qualifiedNameDecoder =
    Decode.map2 QualifiedName
        (Decode.field "home" Decode.string)
        (Decode.field "name" Decode.string)


fieldDecoder : Decoder ( String, Type )
fieldDecoder =
    Decode.map2 Tuple.pair
        (Decode.index 0 Decode.string)
        (Decode.index 1 (Decode.lazy (\() -> decoder)))
