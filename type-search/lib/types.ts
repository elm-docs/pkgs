// Type AST for Elm type expressions

export type Type =
  | { tag: "fn"; args: Type[]; result: Type }
  | { tag: "var"; name: string }
  | { tag: "app"; name: QualifiedName; args: Type[] }
  | { tag: "tuple"; args: Type[] }
  | { tag: "record"; fields: [string, Type][]; ext: string | null };

export interface QualifiedName {
  home: string; // "List", "Basics", "" for unqualified
  name: string; // "List", "Int", etc.
}
