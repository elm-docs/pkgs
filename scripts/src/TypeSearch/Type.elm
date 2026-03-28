module TypeSearch.Type exposing
    ( QualifiedName
    , Type(..)
    , decoder
    , encoder
    )

import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type Type
    = Fn (List Type) Type
    | Var String
    | App QualifiedName (List Type)
    | Tuple (List Type)
    | Record (List ( String, Type )) (Maybe String)


type alias QualifiedName =
    { home : String, name : String }



-- JSON ENCODER (for type_ast column to DB)


encoder : Type -> Encode.Value
encoder tipe =
    case tipe of
        Fn args result ->
            Encode.object
                [ ( "tag", Encode.string "fn" )
                , ( "args", Encode.list encoder args )
                , ( "result", encoder result )
                ]

        Var name ->
            Encode.object
                [ ( "tag", Encode.string "var" )
                , ( "name", Encode.string name )
                ]

        App qname args ->
            Encode.object
                [ ( "tag", Encode.string "app" )
                , ( "name"
                  , Encode.object
                        [ ( "home", Encode.string qname.home )
                        , ( "name", Encode.string qname.name )
                        ]
                  )
                , ( "args", Encode.list encoder args )
                ]

        Tuple args ->
            Encode.object
                [ ( "tag", Encode.string "tuple" )
                , ( "args", Encode.list encoder args )
                ]

        Record fields ext ->
            Encode.object
                [ ( "tag", Encode.string "record" )
                , ( "fields"
                  , Encode.list
                        (\( name, t ) ->
                            Encode.list identity
                                [ Encode.string name
                                , encoder t
                                ]
                        )
                        fields
                  )
                , ( "ext"
                  , case ext of
                        Just e ->
                            Encode.string e

                        Nothing ->
                            Encode.null
                  )
                ]



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
