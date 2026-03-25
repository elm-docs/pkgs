import type { Type, QualifiedName } from "./types.ts";

// Well-known unqualified → qualified mappings for lenient (user query) mode
const LENIENT_RESOLVE: Record<string, QualifiedName> = {
  Int: { home: "Basics", name: "Int" },
  Float: { home: "Basics", name: "Float" },
  Bool: { home: "Basics", name: "Bool" },
  String: { home: "String", name: "String" },
  Char: { home: "Char", name: "Char" },
  Never: { home: "Basics", name: "Never" },
  Order: { home: "Basics", name: "Order" },
  List: { home: "List", name: "List" },
  Maybe: { home: "Maybe", name: "Maybe" },
  Result: { home: "Result", name: "Result" },
  Cmd: { home: "Platform.Cmd", name: "Cmd" },
  Sub: { home: "Platform.Sub", name: "Sub" },
  Task: { home: "Task", name: "Task" },
  Decoder: { home: "Json.Decode", name: "Decoder" },
  Value: { home: "Json.Encode", name: "Value" },
  Html: { home: "Html", name: "Html" },
  Attribute: { home: "Html", name: "Attribute" },
  Svg: { home: "Svg", name: "Svg" },
  Program: { home: "Platform", name: "Program" },
  Dict: { home: "Dict", name: "Dict" },
  Set: { home: "Set", name: "Set" },
  Array: { home: "Array", name: "Array" },
};

export interface ParseOptions {
  lenient?: boolean; // true for user queries, false for docs.json
}

class Parser {
  private pos = 0;
  private readonly src: string;
  private readonly lenient: boolean;

  constructor(src: string, opts?: ParseOptions) {
    this.src = src;
    this.lenient = opts?.lenient ?? false;
  }

  parse(): Type {
    const t = this.parseType();
    this.skipSpaces();
    if (this.pos < this.src.length) {
      throw new Error(
        `Unexpected character at position ${this.pos}: '${this.src[this.pos]}'`,
      );
    }
    return t;
  }

  private parseType(): Type {
    return this.parseFnType();
  }

  private parseFnType(): Type {
    const first = this.parseAppType();
    const args: Type[] = [first];

    while (this.tryConsume(" -> ")) {
      args.push(this.parseAppType());
    }

    if (args.length === 1) return args[0];

    const result = args.pop()!;
    return { tag: "fn", args, result };
  }

  private parseAppType(): Type {
    const head = this.parseAtomType();
    const args: Type[] = [];

    while (true) {
      const saved = this.pos;
      // App args must be separated by space and be atom types
      if (this.pos < this.src.length && this.src[this.pos] === " ") {
        // Peek ahead — don't consume if it's "->" or not an atom
        const afterSpace = this.pos + 1;
        if (afterSpace < this.src.length && this.isAtomStart(afterSpace)) {
          this.pos++; // consume the space
          try {
            args.push(this.parseAtomType());
          } catch {
            this.pos = saved;
            break;
          }
          continue;
        }
      }
      break;
    }

    if (args.length === 0) return head;

    // head must be a named type (app or var)
    if (head.tag === "app") {
      return { tag: "app", name: head.name, args: [...head.args, ...args] };
    }
    if (head.tag === "var") {
      // A variable applied to args — treat as app with unqualified name
      const name = this.resolveName(head.name);
      return { tag: "app", name, args };
    }

    // Otherwise head is tuple/record/fn — can't apply args
    throw new Error(`Cannot apply arguments to ${head.tag} at position ${this.pos}`);
  }

  private isAtomStart(pos: number): boolean {
    const ch = this.src[pos];
    if (ch === "(") return true;
    if (ch === "{") return true;
    // lowercase letter = variable or type arg
    if (ch >= "a" && ch <= "z") return true;
    // uppercase letter = type name
    if (ch >= "A" && ch <= "Z") return true;
    return false;
  }

  private parseAtomType(): Type {
    this.skipSpaces();

    const ch = this.src[this.pos];

    if (ch === "(") return this.parseParenOrTuple();
    if (ch === "{") return this.parseRecord();
    if (ch >= "A" && ch <= "Z") return this.parseQualifiedName();
    if (ch >= "a" && ch <= "z") return this.parseVar();

    throw new Error(
      `Unexpected character at position ${this.pos}: '${ch || "EOF"}'`,
    );
  }

  private parseParenOrTuple(): Type {
    this.expect("(");
    this.skipSpaces();

    // Unit tuple
    if (this.tryConsume(")")) {
      return { tag: "tuple", args: [] };
    }

    const first = this.parseType();
    this.skipSpaces();

    // Just parenthesized
    if (this.tryConsume(")")) return first;

    // Tuple
    const args = [first];
    while (this.tryConsume(",")) {
      this.skipSpaces();
      args.push(this.parseType());
      this.skipSpaces();
    }
    this.expect(")");
    return { tag: "tuple", args };
  }

  private parseRecord(): Type {
    this.expect("{");
    this.skipSpaces();

    // Empty record
    if (this.tryConsume("}")) {
      return { tag: "record", fields: [], ext: null };
    }

    // Check for extensible record: { a | ... }
    let ext: string | null = null;
    const saved = this.pos;

    // Try to parse "varname |"
    if (this.src[this.pos] >= "a" && this.src[this.pos] <= "z") {
      const varName = this.parseIdentifier();
      this.skipSpaces();
      if (this.tryConsume("|")) {
        ext = varName;
        this.skipSpaces();
      } else {
        // Not extensible — might be a field. Check for ":"
        this.pos = saved;
      }
    }

    const fields: [string, Type][] = [];

    // Parse first field
    const fieldName = this.parseIdentifier();
    this.skipSpaces();
    this.expect(":");
    this.skipSpaces();
    const fieldType = this.parseType();
    fields.push([fieldName, fieldType]);
    this.skipSpaces();

    while (this.tryConsume(",")) {
      this.skipSpaces();
      const fn = this.parseIdentifier();
      this.skipSpaces();
      this.expect(":");
      this.skipSpaces();
      const ft = this.parseType();
      fields.push([fn, ft]);
      this.skipSpaces();
    }

    this.skipSpaces();
    this.expect("}");
    return { tag: "record", fields, ext };
  }

  private parseQualifiedName(): Type {
    // Read segments: Foo.Bar.Baz
    // The last uppercase segment after the last dot could be the type name
    // Or all of it could be a single name like "Int"
    const segments: string[] = [];
    segments.push(this.parseUpperIdentifier());

    while (this.pos < this.src.length && this.src[this.pos] === ".") {
      const nextPos = this.pos + 1;
      if (nextPos < this.src.length && this.src[nextPos] >= "A" && this.src[nextPos] <= "Z") {
        this.pos++; // consume dot
        segments.push(this.parseUpperIdentifier());
      } else {
        break;
      }
    }

    // In strict mode: all segments form a qualified name
    // e.g. ["List", "List"] → home="List", name="List"
    // e.g. ["Basics", "Int"] → home="Basics", name="Int"
    // e.g. ["Platform", "Cmd", "Cmd"] → home="Platform.Cmd", name="Cmd"
    // Single segment like ["Int"] → home="", name="Int" (but should be "Basics.Int" in strict)

    const typeName = segments.pop()!;
    const home = segments.join(".");

    let qName: QualifiedName;
    if (home === "" && !this.lenient) {
      // In strict mode, a single uppercase name is still unqualified
      qName = { home: "", name: typeName };
    } else if (home === "" && this.lenient) {
      qName = this.resolveName(typeName);
    } else {
      qName = { home, name: typeName };
    }

    return { tag: "app", name: qName, args: [] };
  }

  private resolveName(name: string): QualifiedName {
    if (this.lenient && LENIENT_RESOLVE[name]) {
      return LENIENT_RESOLVE[name];
    }
    return { home: "", name };
  }

  private parseVar(): Type {
    const name = this.parseIdentifier();
    return { tag: "var", name };
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.src.length && this.isIdentChar(this.src[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new Error(`Expected identifier at position ${this.pos}`);
    }
    return this.src.slice(start, this.pos);
  }

  private parseUpperIdentifier(): string {
    const ch = this.src[this.pos];
    if (!(ch >= "A" && ch <= "Z")) {
      throw new Error(`Expected uppercase identifier at position ${this.pos}`);
    }
    return this.parseIdentifier();
  }

  private isIdentChar(ch: string): boolean {
    return (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" ||
      ch === "'"
    );
  }

  private skipSpaces(): void {
    while (this.pos < this.src.length && this.src[this.pos] === " ") {
      this.pos++;
    }
  }

  private expect(s: string): void {
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length;
    } else {
      const got = this.src.slice(this.pos, this.pos + 10);
      throw new Error(`Expected '${s}' at position ${this.pos}, got '${got}'`);
    }
  }

  private tryConsume(s: string): boolean {
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length;
      return true;
    }
    return false;
  }
}

export function parseType(src: string, opts?: ParseOptions): Type {
  return new Parser(src, opts).parse();
}
