// Turns the Postgres SQL the app sends into SQLite SQL, mechanically, one
// token at a time. Only syntax SQLite lacks is rewritten; functions with
// Postgres names are registered on the connection instead (functions.ts).
// Anything recognized as Postgres that cannot be translated throws
// UnsupportedSqlError rather than passing through half-translated.
//
// See docs/design/database-backends.md, "How SQLite runs Postgres SQL".

export class UnsupportedSqlError extends Error {
  constructor(construct: string, sql: string) {
    super(
      `SQLite backend: ${construct} is not supported. Add it to src/lib/db/sqlite/rewrite.ts. Statement: ${sql.replace(/\s+/g, " ").trim().slice(0, 300)}`,
    );
    this.name = "UnsupportedSqlError";
  }
}

/** How a result column computed by an expression is to be read back. */
export type TypeHint = "bool" | "json" | "date";

/**
 * "locking-read" is a SELECT … FOR UPDATE/SHARE: inside a transaction it
 * takes the write lock, as a write does; outside one it is a plain read.
 */
export type StatementKind =
  | "begin"
  | "commit"
  | "rollback"
  | "advisory"
  | "read"
  | "locking-read"
  | "write";

export type Rewritten = {
  kind: StatementKind;
  /** The SQLite statement (for "advisory", the key expression as a SELECT). */
  sql: string;
  /** Types for result columns that SQLite reports no declared type for. */
  hints: ReadonlyMap<string, TypeHint>;
  /** For "advisory": whether it is the try form, and the result's name. */
  advisory?: { column: string; isTry: boolean };
  /**
   * A data-modifying WITH: these statements run first, in order, each
   * binding the first `parameters` parameters. The rows one returns go to
   * the statements after it as JSON, in parameter `rowsParameter` (null
   * for a part with no RETURNING).
   */
  preSteps?: {
    parameters: number;
    rowsParameter: number | null;
    sql: string;
  }[];
  /** With preSteps: how many parameters `sql` binds. */
  parameters?: number;
  /**
   * For "begin": REPEATABLE READ or SERIALIZABLE. The transaction's reads
   * then see the database as it was at its first one, as on Postgres.
   */
  snapshot?: boolean;
};

/** Column types by table, for row_to_json and type hints. */
export type SchemaInfo = {
  /** The columns of a named UNIQUE constraint, for ON CONFLICT ON CONSTRAINT. */
  constraintColumns?(name: string): string[] | null;
  /** The declared type of a column name, when every table agrees on it. */
  columnType(name: string): string | null;
  /** The columns of a table, in order, with declared types. */
  tableColumns(table: string): { name: string; type: string }[] | null;
};

type TokenType =
  "ident" | "qident" | "string" | "number" | "param" | "op" | "punct";

type Token = { type: TokenType; text: string };

const OPERATORS = [
  "->>",
  "#>>",
  "::",
  "->",
  "#>",
  "<>",
  "!=",
  "<=",
  ">=",
  "||",
  "<@",
  "@>",
  "!~*",
  "!~",
  "~*",
  "?|",
  "?&",
];

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (
      char === "'" ||
      ((char === "E" || char === "e") && sql[i + 1] === "'")
    ) {
      if (char !== "'") {
        throw new UnsupportedSqlError("an E'' string", sql);
      }

      let j = i + 1;

      for (;;) {
        if (j >= sql.length) {
          throw new UnsupportedSqlError("an unterminated string", sql);
        }

        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }

          break;
        }

        j += 1;
      }

      tokens.push({ text: sql.slice(i, j + 1), type: "string" });
      i = j + 1;
      continue;
    }

    if (char === '"') {
      let j = i + 1;

      for (;;) {
        if (j >= sql.length) {
          throw new UnsupportedSqlError("an unterminated identifier", sql);
        }

        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }

          break;
        }

        j += 1;
      }

      tokens.push({ text: sql.slice(i, j + 1), type: "qident" });
      i = j + 1;
      continue;
    }

    if (char === "$") {
      const match = /^\$(\d+)/.exec(sql.slice(i));

      if (!match) {
        throw new UnsupportedSqlError("dollar quoting", sql);
      }

      tokens.push({ text: match[0], type: "param" });
      i += match[0].length;
      continue;
    }

    if (
      /[0-9]/.test(char) ||
      (char === "." && /[0-9]/.test(sql[i + 1] ?? ""))
    ) {
      const match = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i))!;

      tokens.push({ text: match[0], type: "number" });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;

      tokens.push({ text: match[0], type: "ident" });
      i += match[0].length;
      continue;
    }

    const operator = OPERATORS.find((candidate) =>
      sql.startsWith(candidate, i),
    );

    if (operator) {
      tokens.push({ text: operator, type: "op" });
      i += operator.length;
      continue;
    }

    tokens.push({
      text: char,
      type: "(),;.[]".includes(char) ? "punct" : "op",
    });
    i += 1;
  }

  // A trailing semicolon ends the one statement; anything after it is a
  // second statement, which pg's extended protocol refuses too.
  while (tokens.at(-1)?.text === ";") {
    tokens.pop();
  }

  if (tokens.some((token) => token.text === ";")) {
    throw new UnsupportedSqlError("more than one statement", sql);
  }

  return tokens;
}

function upper(token: Token | undefined): string {
  return token && token.type === "ident" ? token.text.toUpperCase() : "";
}

function isWord(token: Token | undefined, ...words: string[]): boolean {
  return words.includes(upper(token));
}

function ident(text: string): Token {
  return { text, type: "ident" };
}

function punct(text: string): Token {
  return { text, type: "punct" };
}

function op(text: string): Token {
  return { text, type: "op" };
}

/** Index of the parenthesis that closes the one at `open`. */
function closingParen(tokens: Token[], open: number): number {
  let depth = 0;

  for (let i = open; i < tokens.length; i += 1) {
    const text = tokens[i]!.text;

    if (tokens[i]!.type === "punct" && (text === "(" || text === "[")) {
      depth += 1;
    } else if (tokens[i]!.type === "punct" && (text === ")" || text === "]")) {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error("Unbalanced parentheses.");
}

function openingParen(tokens: Token[], close: number): number {
  let depth = 0;

  for (let i = close; i >= 0; i -= 1) {
    const text = tokens[i]!.text;

    if (tokens[i]!.type === "punct" && (text === ")" || text === "]")) {
      depth += 1;
    } else if (tokens[i]!.type === "punct" && (text === "(" || text === "[")) {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error("Unbalanced parentheses.");
}

// Words that end an expression on their left: `NOT (…)` and `IN (…)` are
// not function calls.
const NOT_FUNCTION_NAMES = new Set([
  "AND",
  "OR",
  "NOT",
  "IN",
  "EXISTS",
  "ANY",
  "ALL",
  "SELECT",
  "WHERE",
  "ON",
  "FROM",
  "JOIN",
  "AS",
  "VALUES",
  "THEN",
  "ELSE",
  "WHEN",
  "CASE",
  "IS",
  "BY",
  "USING",
  "RETURNING",
  "SET",
  "INTO",
  "FILTER",
  "OVER",
]);

/** Start of the primary expression that ends at index `end`. */
function operandStart(tokens: Token[], end: number, sql: string): number {
  const last = tokens[end];

  if (!last) {
    throw new UnsupportedSqlError("an operator with no left operand", sql);
  }

  let start: number;

  if (last.type === "punct" && (last.text === ")" || last.text === "]")) {
    start = openingParen(tokens, end);

    const before = tokens[start - 1];

    // count(*) FILTER (WHERE …), sum(x) OVER (…)
    if (last.text === ")" && isWord(before, "FILTER", "OVER")) {
      return operandStart(tokens, start - 2, sql);
    }

    if (
      last.text === ")" &&
      before &&
      (before.type === "ident" || before.type === "qident") &&
      !NOT_FUNCTION_NAMES.has(upper(before))
    ) {
      start -= 1;
    } else if (last.text === "]") {
      // ARRAY[…], or a subscript a[1]
      return isWord(before, "ARRAY")
        ? start - 1
        : operandStart(tokens, start - 1, sql);
    }
  } else {
    start = end;
  }

  // a.b.c
  while (
    tokens[start - 1]?.text === "." &&
    (tokens[start - 2]?.type === "ident" ||
      tokens[start - 2]?.type === "qident")
  ) {
    start -= 2;
  }

  return start;
}

/** End (inclusive) of the primary expression that starts at `start`. */
function operandEnd(tokens: Token[], start: number, sql: string): number {
  const first = tokens[start];

  if (!first) {
    throw new UnsupportedSqlError("an operator with no right operand", sql);
  }

  if (first.type === "punct" && first.text === "(") {
    return closingParen(tokens, start);
  }

  let end = start;

  if (
    (first.type === "ident" || first.type === "qident") &&
    tokens[start + 1]?.text === "("
  ) {
    end = closingParen(tokens, start + 1);
  }

  while (
    tokens[end + 1]?.text === "." &&
    (tokens[end + 2]?.type === "ident" || tokens[end + 2]?.type === "qident")
  ) {
    end += 2;
  }

  // A cast already rewritten as a call stays attached through its own
  // parentheses; a cast still in place extends the operand.
  while (tokens[end + 1]?.text === "::") {
    end = castTypeEnd(tokens, end + 2).end;
  }

  return end;
}

/** The type named by a cast starting at `start`, and where it ends. */
function castTypeEnd(
  tokens: Token[],
  start: number,
): { end: number; type: string } {
  const words: string[] = [];
  let end = start;

  for (;;) {
    const token = tokens[end];

    if (!token || (token.type !== "ident" && token.type !== "qident")) {
      break;
    }

    words.push(token.text.replace(/"/g, "").toLowerCase());
    end += 1;

    // Multi-word types: double precision, timestamp with time zone.
    const next = upper(tokens[end]);

    if (!(
      (words.at(-1) === "double" && next === "PRECISION") ||
      (words.at(-1) === "timestamp" &&
        (next === "WITH" || next === "WITHOUT")) ||
      ((words.at(-1) === "with" || words.at(-1) === "without") &&
        next === "TIME") ||
      (words.at(-1) === "time" && next === "ZONE") ||
      (words.at(-1) === "character" && next === "VARYING")
    )) {
      break;
    }
  }

  // (n) as in varchar(20)
  if (tokens[end]?.text === "(" && words.length > 0) {
    end = closingParen(tokens, end) + 1;
  }

  // text[]
  if (tokens[end]?.text === "[" && tokens[end + 1]?.text === "]") {
    words.push("[]");
    end += 2;
  }

  return { end: end - 1, type: words.join(" ").replace(" []", "[]") };
}

const INT_TYPES = new Set([
  "int",
  "integer",
  "int2",
  "int4",
  "int8",
  "bigint",
  "smallint",
]);
const REAL_TYPES = new Set([
  "numeric",
  "decimal",
  "real",
  "float",
  "float4",
  "float8",
  "double precision",
]);
const TEXT_TYPES = new Set(["text", "varchar", "character varying", "char"]);
const DROPPED_TYPES = new Set([
  "json",
  "jsonb",
  "boolean",
  "bool",
  "timestamptz",
  "timestamp",
  "timestamp with time zone",
  "timestamp without time zone",
  "date",
  "bytea",
  "uuid",
]);

function castCategory(type: string): TypeHint | null {
  if (type === "json" || type === "jsonb" || type.endsWith("[]")) {
    return "json";
  }

  if (type === "boolean" || type === "bool") {
    return "bool";
  }

  if (type.startsWith("timestamp") || type === "date") {
    return "date";
  }

  return null;
}

function rewriteCasts(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (out[i]!.text !== "::") {
      continue;
    }

    const start = operandStart(out, i - 1, sql);
    const { end, type } = castTypeEnd(out, i + 1);
    const operand = out.slice(start, i);
    let replacement: Token[];

    if (INT_TYPES.has(type)) {
      replacement = [ident("pg_int"), punct("("), ...operand, punct(")")];
    } else if (REAL_TYPES.has(type)) {
      replacement = [
        ident("CAST"),
        punct("("),
        ...operand,
        ident("AS"),
        ident("REAL"),
        punct(")"),
      ];
    } else if (TEXT_TYPES.has(type)) {
      replacement = [
        ident("CAST"),
        punct("("),
        ...operand,
        ident("AS"),
        ident("TEXT"),
        punct(")"),
      ];
    } else if (DROPPED_TYPES.has(type) || type.endsWith("[]")) {
      replacement = operand;
    } else {
      throw new UnsupportedSqlError(`a cast to ${type}`, sql);
    }

    out.splice(start, end - start + 1, ...replacement);
    i = start + replacement.length - 1;
  }

  return out;
}

/** `x = ANY(e)` and `x <> ALL(e)`. */
/**
 * `… UNION ALL (SELECT … ORDER BY … LIMIT …)`: SQLite takes no parentheses
 * around a part of a compound SELECT, nor an ORDER BY or LIMIT of its own,
 * so the part becomes `SELECT * FROM (…)`, which returns the same rows.
 */
function rewriteParenthesizedCompound(tokens: Token[]): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "UNION", "INTERSECT", "EXCEPT")) {
      continue;
    }

    const open = isWord(out[i + 1], "ALL", "DISTINCT") ? i + 2 : i + 1;

    if (out[open]?.text !== "(" || !isWord(out[open + 1], "SELECT", "WITH")) {
      continue;
    }

    const close = closingParen(out, open);

    out.splice(
      open,
      close - open + 1,
      ident("SELECT"),
      op("*"),
      ident("FROM"),
      ...out.slice(open, close + 1),
    );
  }

  return out;
}

function rewriteAnyAll(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    const word = upper(out[i]);

    if ((word !== "ANY" && word !== "ALL") || out[i + 1]?.text !== "(") {
      continue;
    }

    const operator = out[i - 1]?.text;
    const negated = word === "ALL";

    if (
      (word === "ANY" && operator !== "=") ||
      (negated && operator !== "<>" && operator !== "!=")
    ) {
      throw new UnsupportedSqlError(`${operator ?? ""} ${word}(…)`, sql);
    }

    const close = closingParen(out, i + 1);
    const inner = out.slice(i + 2, close);
    const isSubquery = isWord(inner[0], "SELECT", "WITH");
    const list: Token[] = isSubquery
      ? [punct("("), ...inner, punct(")")]
      : [
          punct("("),
          ident("SELECT"),
          ident("value"),
          ident("FROM"),
          ident("json_each"),
          punct("("),
          ...inner,
          punct(")"),
          punct(")"),
        ];
    const replacement = [
      ...(negated ? [ident("NOT")] : []),
      ident("IN"),
      ...list,
    ];

    out.splice(i - 1, close - i + 2, ...replacement);
    i = i - 1 + replacement.length - 1;
  }

  return out;
}

/** ARRAY(SELECT …) and ARRAY[…]. */
function rewriteArrays(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "ARRAY")) {
      continue;
    }

    if (out[i + 1]?.text === "[") {
      const close = closingParen(out, i + 1);
      const replacement = [
        ident("json_array"),
        punct("("),
        ...out.slice(i + 2, close),
        punct(")"),
      ];

      out.splice(i, close - i + 1, ...replacement);
      continue;
    }

    if (out[i + 1]?.text !== "(" || !isWord(out[i + 2], "SELECT")) {
      throw new UnsupportedSqlError("this use of ARRAY", sql);
    }

    const close = closingParen(out, i + 1);
    const inner = out.slice(i + 3, close);
    const from = topLevelIndex(inner, "FROM");

    if (from === -1) {
      throw new UnsupportedSqlError("ARRAY(SELECT …) without FROM", sql);
    }

    const expression = inner.slice(0, from);
    const rest = inner.slice(from);
    const orderBy = topLevelSequence(rest, ["ORDER", "BY"]);
    const limit = topLevelIndex(rest, "LIMIT");
    let replacement: Token[];

    if (limit !== -1) {
      replacement = [
        punct("("),
        ident("SELECT"),
        ident("json_group_array"),
        punct("("),
        ident("v"),
        punct(")"),
        ident("FROM"),
        punct("("),
        ident("SELECT"),
        ...expression,
        ident("AS"),
        ident("v"),
        ...rest,
        punct(")"),
        punct(")"),
      ];
    } else if (orderBy !== -1) {
      replacement = [
        punct("("),
        ident("SELECT"),
        ident("json_group_array"),
        punct("("),
        ...expression,
        ...rest.slice(orderBy),
        punct(")"),
        ...rest.slice(0, orderBy),
        punct(")"),
      ];
    } else {
      replacement = [
        punct("("),
        ident("SELECT"),
        ident("json_group_array"),
        punct("("),
        ...expression,
        punct(")"),
        ...rest,
        punct(")"),
      ];
    }

    out.splice(i, close - i + 1, ...replacement);
  }

  return out;
}

/** Index of the first `word` outside parentheses and CASE…END. */
function topLevelIndex(tokens: Token[], word: string, from = 0): number {
  let depth = 0;

  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.type === "punct" && (token.text === "(" || token.text === "[")) {
      depth += 1;
    } else if (
      token.type === "punct" &&
      (token.text === ")" || token.text === "]")
    ) {
      depth -= 1;
    } else if (
      depth === 0 &&
      upper(token) === word &&
      // The FROM of `IS [NOT] DISTINCT FROM` starts no clause.
      !(word === "FROM" && isWord(tokens[i - 1], "DISTINCT"))
    ) {
      return i;
    }
  }

  return -1;
}

function topLevelSequence(tokens: Token[], words: string[]): number {
  for (
    let i = topLevelIndex(tokens, words[0]!);
    i !== -1;
    i = topLevelIndex(tokens, words[0]!, i + 1)
  ) {
    if (words.every((word, offset) => upper(tokens[i + offset]) === word)) {
      return i;
    }
  }

  return -1;
}

/** Splits at commas outside parentheses. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;

  for (const token of tokens) {
    if (token.type === "punct" && (token.text === "(" || token.text === "[")) {
      depth += 1;
    } else if (
      token.type === "punct" &&
      (token.text === ")" || token.text === "]")
    ) {
      depth -= 1;
    }

    if (depth === 0 && token.text === ",") {
      parts.push([]);
    } else {
      parts.at(-1)!.push(token);
    }
  }

  return parts;
}

/** Whether the statement locks rows anywhere: FOR UPDATE, FOR SHARE, … */
function hasRowLock(tokens: Token[]): boolean {
  return tokens.some(
    (token, i) =>
      isWord(token, "FOR") &&
      (isWord(tokens[i + 1], "UPDATE", "SHARE") ||
        (isWord(tokens[i + 1], "NO") && isWord(tokens[i + 2], "KEY")) ||
        (isWord(tokens[i + 1], "KEY") && isWord(tokens[i + 2], "SHARE"))),
  );
}

/** FOR UPDATE [OF a, b] [NOWAIT | SKIP LOCKED], FOR SHARE, … */
function stripRowLocks(tokens: Token[]): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "FOR")) {
      continue;
    }

    let j = i + 1;

    if (isWord(out[j], "UPDATE", "SHARE")) {
      j += 1;
    } else if (
      isWord(out[j], "NO") &&
      isWord(out[j + 1], "KEY") &&
      isWord(out[j + 2], "UPDATE")
    ) {
      j += 3;
    } else if (isWord(out[j], "KEY") && isWord(out[j + 1], "SHARE")) {
      j += 2;
    } else {
      continue;
    }

    if (isWord(out[j], "OF")) {
      j += 1;

      for (;;) {
        // table or alias, possibly qualified
        j += 1;

        while (out[j]?.text === ".") {
          j += 2;
        }

        if (out[j]?.text !== ",") {
          break;
        }

        j += 1;
      }
    }

    if (isWord(out[j], "NOWAIT")) {
      j += 1;
    } else if (isWord(out[j], "SKIP") && isWord(out[j + 1], "LOCKED")) {
      j += 2;
    }

    out.splice(i, j - i);
    i -= 1;
  }

  return out;
}

/** EXTRACT(EPOCH FROM x) */
function rewriteExtract(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "EXTRACT") || out[i + 1]?.text !== "(") {
      continue;
    }

    const close = closingParen(out, i + 1);
    const field = upper(out[i + 2]);

    if (!isWord(out[i + 3], "FROM")) {
      throw new UnsupportedSqlError("this EXTRACT", sql);
    }

    const operand = out.slice(i + 4, close);
    const replacement =
      field === "EPOCH"
        ? [ident("pg_epoch"), punct("("), ...operand, punct(")")]
        : [
            ident("pg_extract"),
            punct("("),
            { text: `'${field.toLowerCase()}'`, type: "string" as const },
            punct(","),
            ...operand,
            punct(")"),
          ];

    out.splice(i, close - i + 1, ...replacement);
  }

  return out;
}

/** x + interval '1 day', x - interval '1 minute' */
function rewriteIntervals(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "INTERVAL") || out[i + 1]?.type !== "string") {
      continue;
    }

    const sign = out[i - 1]?.text;

    if (sign !== "+" && sign !== "-") {
      throw new UnsupportedSqlError("an interval outside x ± interval", sql);
    }

    const start = operandStart(out, i - 2, sql);
    const replacement = [
      ident("pg_interval_add"),
      punct("("),
      ...out.slice(start, i - 1),
      punct(","),
      out[i + 1]!,
      punct(","),
      { text: sign === "-" ? "-1" : "1", type: "number" as const },
      punct(")"),
    ];

    out.splice(start, i + 2 - start, ...replacement);
    i = start + replacement.length - 1;
  }

  return out;
}

/** position(a IN b), substring(s FROM …), generate_series, unnest. */
function rewriteSpecialForms(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    const word = upper(out[i]);

    if (out[i + 1]?.text !== "(" || out[i - 1]?.text === ".") {
      continue;
    }

    if (word === "POSITION") {
      const close = closingParen(out, i + 1);
      const inner = out.slice(i + 2, close);
      const inAt = topLevelIndex(inner, "IN");

      if (inAt === -1) {
        continue;
      }

      const replacement = [
        ident("instr"),
        punct("("),
        ...inner.slice(inAt + 1),
        punct(","),
        ...inner.slice(0, inAt),
        punct(")"),
      ];

      out.splice(i, close - i + 1, ...replacement);
    } else if (word === "SUBSTRING") {
      const close = closingParen(out, i + 1);
      const inner = out.slice(i + 2, close);
      const fromAt = topLevelIndex(inner, "FROM");

      if (fromAt === -1) {
        out[i] = ident("substr");
        continue;
      }

      const forAt = topLevelIndex(inner, "FOR");
      const subject = inner.slice(0, fromAt);
      const from = inner.slice(fromAt + 1, forAt === -1 ? undefined : forAt);
      let replacement: Token[];

      if (forAt === -1 && from.length === 1 && from[0]!.type === "string") {
        replacement = [
          ident("pg_regexp_substring"),
          punct("("),
          ...subject,
          punct(","),
          ...from,
          punct(")"),
        ];
      } else {
        replacement = [
          ident("substr"),
          punct("("),
          ...subject,
          punct(","),
          ...from,
          ...(forAt === -1 ? [] : [punct(","), ...inner.slice(forAt + 1)]),
          punct(")"),
        ];
      }

      out.splice(i, close - i + 1, ...replacement);
    } else if (word === "GENERATE_SERIES" || word === "UNNEST") {
      const close = closingParen(out, i + 1);
      const args = splitTopLevel(out.slice(i + 2, close));
      let aliasAt = close + 1;

      if (isWord(out[aliasAt], "AS")) {
        aliasAt += 1;
      }

      const alias = out[aliasAt];

      if (
        !alias ||
        (alias.type !== "ident" && alias.type !== "qident") ||
        NOT_FUNCTION_NAMES.has(upper(alias)) ||
        isWord(
          alias,
          "WHERE",
          "ORDER",
          "GROUP",
          "LIMIT",
          "CROSS",
          "LEFT",
          "INNER",
        )
      ) {
        throw new UnsupportedSqlError(
          `${word.toLowerCase()}(…) without an alias`,
          sql,
        );
      }

      // unnest(x) AS a(col): the column is called col, not a.
      const columnList =
        out[aliasAt + 1]?.text === "(" &&
        (out[aliasAt + 2]?.type === "ident" ||
          out[aliasAt + 2]?.type === "qident") &&
        out[aliasAt + 3]?.text === ")";
      const column = columnList ? out[aliasAt + 2]! : alias;
      const end = columnList ? aliasAt + 3 : aliasAt;
      let subquery: Token[];

      if (word === "UNNEST") {
        if (args.length !== 1) {
          throw new UnsupportedSqlError("unnest of several arrays", sql);
        }

        subquery = [
          punct("("),
          ident("SELECT"),
          ident("value"),
          ident("AS"),
          column,
          ident("FROM"),
          ident("json_each"),
          punct("("),
          ...args[0]!,
          punct(")"),
          punct(")"),
        ];
      } else {
        if (args.length !== 2) {
          throw new UnsupportedSqlError("generate_series with a step", sql);
        }

        subquery = [
          punct("("),
          ident("WITH"),
          ident("RECURSIVE"),
          ident("_series"),
          punct("("),
          ident("v"),
          punct(")"),
          ident("AS"),
          punct("("),
          ident("SELECT"),
          ...args[0]!,
          ident("WHERE"),
          ...args[0]!,
          op("<="),
          punct("("),
          ...args[1]!,
          punct(")"),
          ident("UNION"),
          ident("ALL"),
          ident("SELECT"),
          ident("v"),
          op("+"),
          { text: "1", type: "number" },
          ident("FROM"),
          ident("_series"),
          ident("WHERE"),
          ident("v"),
          op("<"),
          punct("("),
          ...args[1]!,
          punct(")"),
          punct(")"),
          ident("SELECT"),
          ident("v"),
          ident("AS"),
          column,
          ident("FROM"),
          ident("_series"),
          punct(")"),
        ];
      }

      const replacement = [...subquery, ident("AS"), alias];

      out.splice(i, end - i + 1, ...replacement);
      i += replacement.length - 1;
    }
  }

  return out;
}

const FUNCTION_RENAMES: Record<string, string> = {
  ARRAY_AGG: "json_group_array",
  CURRENT_TIMESTAMP: "now",
  JSONB_AGG: "json_group_array",
  JSONB_ARRAY_LENGTH: "json_array_length",
  JSONB_BUILD_OBJECT: "json_object",
  JSONB_TYPEOF: "pg_jsonb_typeof",
  JSON_AGG: "json_group_array",
  JSON_BUILD_OBJECT: "json_object",
  LEFT: "pg_left",
  RIGHT: "pg_right",
};

/**
 * to_regclass('name'): the table's name when the table exists, otherwise
 * NULL, read from SQLite's own catalogue. A "public." prefix is dropped.
 * The app asks it before using a table a migration may not have made yet.
 */
function rewriteToRegclass(tokens: Token[]): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (
      !isWord(out[i], "TO_REGCLASS") ||
      out[i - 1]?.text === "." ||
      out[i + 1]?.text !== "("
    ) {
      continue;
    }

    const close = closingParen(out, i + 1);
    const argument = out.slice(i + 2, close);
    const replacement: Token[] = [
      punct("("),
      ident("SELECT"),
      ident("name"),
      ident("FROM"),
      ident("sqlite_master"),
      ident("WHERE"),
      ident("type"),
      ident("IN"),
      punct("("),
      { text: "'table'", type: "string" },
      punct(","),
      { text: "'view'", type: "string" },
      punct(")"),
      ident("AND"),
      ident("name"),
      op("="),
      ident("replace"),
      punct("("),
      ...argument,
      punct(","),
      { text: "'public.'", type: "string" },
      punct(","),
      { text: "''", type: "string" },
      punct(")"),
      punct(")"),
    ];

    out.splice(i, close - i + 1, ...replacement);
    i += replacement.length - 1;
  }

  return out;
}

/** row_to_json(alias) from the table's columns. */
function rewriteRowToJson(
  tokens: Token[],
  sql: string,
  schema: SchemaInfo | null,
): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!isWord(out[i], "ROW_TO_JSON") || out[i + 1]?.text !== "(") {
      continue;
    }

    const close = closingParen(out, i + 1);
    const alias = out[i + 2];

    if (close !== i + 3 || !alias || !schema) {
      throw new UnsupportedSqlError(
        "row_to_json of anything but a table alias",
        sql,
      );
    }

    const table = tableForAlias(out, alias.text);
    const columns = table ? schema.tableColumns(table) : null;

    if (!columns) {
      throw new UnsupportedSqlError(`row_to_json(${alias.text})`, sql);
    }

    const args: Token[] = [];

    for (const column of columns) {
      const reference = [
        alias,
        punct("."),
        {
          text: `"${column.name.replace(/"/g, '""')}"`,
          type: "qident" as const,
        },
      ];
      const type = column.type.toUpperCase();
      let value: Token[] = reference;

      if (type.includes("JSON") || type.endsWith("[]")) {
        value = [ident("json"), punct("("), ...reference, punct(")")];
      } else if (type.includes("BOOL")) {
        value = [
          ident("json"),
          punct("("),
          ident("pg_json_bool"),
          punct("("),
          ...reference,
          punct(")"),
          punct(")"),
        ];
      }

      if (args.length > 0) {
        args.push(punct(","));
      }

      args.push(
        { text: `'${column.name.replace(/'/g, "''")}'`, type: "string" },
        punct(","),
        ...value,
      );
    }

    const replacement = [ident("json_object"), punct("("), ...args, punct(")")];

    out.splice(i, close - i + 1, ...replacement);
    i += replacement.length - 1;
  }

  return out;
}

function unquote(text: string): string {
  return text.startsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text;
}

/** The table an alias in a FROM or JOIN names. */
function tableForAlias(tokens: Token[], alias: string): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isWord(tokens[i], "FROM", "JOIN", "UPDATE", "INTO")) {
      continue;
    }

    let j = i + 1;

    if (upper(tokens[j]) === "PUBLIC" && tokens[j + 1]?.text === ".") {
      j += 2;
    }

    const table = tokens[j];

    if (!table || (table.type !== "ident" && table.type !== "qident")) {
      continue;
    }

    let aliasAt = j + 1;

    if (isWord(tokens[aliasAt], "AS")) {
      aliasAt += 1;
    }

    const name = unquote(table.text);
    const given = tokens[aliasAt];

    if (
      (given &&
        (given.type === "ident" || given.type === "qident") &&
        unquote(given.text) === unquote(alias)) ||
      name === unquote(alias)
    ) {
      return name;
    }
  }

  return null;
}

function rewriteNamesAndParams(tokens: Token[]): Token[] {
  const out: Token[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    // public.table → table
    if (
      upper(token) === "PUBLIC" &&
      tokens[i + 1]?.text === "." &&
      tokens[i - 1]?.text !== "."
    ) {
      i += 1;
      continue;
    }

    if (token.type === "param") {
      out.push({ text: `?${token.text.slice(1)}`, type: "param" });
      continue;
    }

    const rename = FUNCTION_RENAMES[upper(token)];

    if (
      rename &&
      tokens[i - 1]?.text !== "." &&
      (tokens[i + 1]?.text === "(" || upper(token) === "CURRENT_TIMESTAMP")
    ) {
      out.push(ident(rename));

      if (upper(token) === "CURRENT_TIMESTAMP" && tokens[i + 1]?.text !== "(") {
        out.push(punct("("), punct(")"));
      }

      continue;
    }

    out.push(token);
  }

  return out;
}

/** ON CONFLICT ON CONSTRAINT name → ON CONFLICT (its columns). */
function rewriteConflictConstraint(
  tokens: Token[],
  sql: string,
  schema: SchemaInfo | null,
): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (!(
      isWord(out[i], "CONFLICT") &&
      isWord(out[i + 1], "ON") &&
      isWord(out[i + 2], "CONSTRAINT")
    )) {
      continue;
    }

    const name = out[i + 3] ? unquote(out[i + 3]!.text) : "";
    const columns = schema?.constraintColumns?.(name);

    if (!columns) {
      throw new UnsupportedSqlError(`ON CONFLICT ON CONSTRAINT ${name}`, sql);
    }

    const list: Token[] = [punct("(")];

    columns.forEach((column, index) => {
      if (index > 0) list.push(punct(","));
      list.push({ text: `"${column.replace(/"/g, '""')}"`, type: "qident" });
    });
    list.push(punct(")"));
    out.splice(i + 1, 3, ...list);
  }

  return out;
}

// Words that can follow a table name where an alias could be.
const AFTER_TABLE = new Set([
  "SET",
  "WHERE",
  "AS",
  "RETURNING",
  "FROM",
  "INDEXED",
  "NOT",
  "ORDER",
  "LIMIT",
]);

/** UPDATE t x / DELETE FROM t x: SQLite wants `AS x`. */
function addTargetAs(tokens: Token[]): Token[] {
  // After a WITH, the statement starts at its first top-level verb.
  const update = topLevelIndex(tokens, "UPDATE");
  const remove = topLevelIndex(tokens, "DELETE");
  const insert = topLevelIndex(tokens, "INSERT");

  // ON CONFLICT … DO UPDATE SET is not an UPDATE statement, after a WITH
  // either.
  if (
    isWord(tokens[0], "INSERT") ||
    (insert !== -1 && (update === -1 || insert < update))
  ) {
    return tokens;
  }
  let at: number;

  if (update !== -1 && (remove === -1 || update < remove)) {
    at = update + 1;
  } else if (remove !== -1 && isWord(tokens[remove + 1], "FROM")) {
    at = remove + 2;
  } else {
    return tokens;
  }

  // the table, possibly qualified
  at += 1;

  while (tokens[at]?.text === ".") {
    at += 2;
  }

  const alias = tokens[at];

  if (
    !alias ||
    (alias.type !== "ident" && alias.type !== "qident") ||
    AFTER_TABLE.has(upper(alias))
  ) {
    return tokens;
  }

  return [...tokens.slice(0, at), ident("AS"), ...tokens.slice(at)];
}

/** Names a FROM clause gives its tables: `envelopes e`, `(…) k`, `due`. */
function fromAliases(from: Token[]): Set<string> {
  const aliases = new Set<string>();
  let depth = 0;

  for (let i = 0; i < from.length; i += 1) {
    const token = from[i]!;

    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;

    if (
      depth === 0 &&
      (token.type === "ident" || token.type === "qident") &&
      !NOT_FUNCTION_NAMES.has(upper(token)) &&
      !isWord(
        token,
        "LEFT",
        "RIGHT",
        "INNER",
        "OUTER",
        "CROSS",
        "FULL",
        "NATURAL",
        "LATERAL",
      )
    ) {
      const next = from[i + 1];

      // the last name of each item is what it is called
      if (
        !next ||
        next.text === "," ||
        isWord(
          next,
          "JOIN",
          "LEFT",
          "INNER",
          "CROSS",
          "ON",
          "WHERE",
          "RIGHT",
          "FULL",
        )
      ) {
        aliases.add(unquote(token.text));
      }
    }
  }

  return aliases;
}

/**
 * UPDATE … FROM … RETURNING other.col: SQLite does not let the FROM tables
 * appear in RETURNING, so each such item becomes a subquery over the same
 * FROM, joined by the conditions of the WHERE that mention them.
 */
function rewriteUpdateFromReturning(tokens: Token[]): Token[] {
  if (isWord(tokens[0], "INSERT")) {
    return tokens;
  }

  const returning = topLevelIndex(tokens, "RETURNING");
  const update = topLevelIndex(tokens, "UPDATE");
  const remove = topLevelIndex(tokens, "DELETE");
  const verb = update !== -1 ? update : remove;

  if (returning === -1 || verb === -1) {
    return tokens;
  }

  const tableAt = verb === update ? verb + 1 : verb + 2;
  // Inside RETURNING the table answers to its name, not its alias.
  const table = tokens[tableAt]!;
  const targetAlias = isWord(tokens[tableAt + 1], "AS")
    ? unquote(tokens[tableAt + 2]!.text)
    : null;
  const byTableName = (part: Token[]): Token[] =>
    part.map((token, index) =>
      targetAlias &&
      part[index + 1]?.text === "." &&
      unquote(token.text) === targetAlias
        ? table
        : token,
    );
  const from = verb === update ? topLevelIndex(tokens, "FROM", tableAt) : -1;
  const where = topLevelIndex(tokens, "WHERE", tableAt);
  const fromClause =
    from === -1 || from > returning
      ? []
      : tokens.slice(from + 1, where === -1 ? returning : where);
  const aliases = fromAliases(fromClause);
  const conditions = where === -1 ? [] : tokens.slice(where + 1, returning);
  const conjuncts = splitOnTopLevelAnd(conditions);
  const joining = conjuncts.filter((conjunct) =>
    conjunct.some(
      (token, index) =>
        conjunct[index + 1]?.text === "." && aliases.has(unquote(token.text)),
    ),
  );
  const items = splitTopLevel(tokens.slice(returning + 1));
  const rewritten: Token[] = [];

  items.forEach((item, index) => {
    const mentionsFrom = item.some(
      (token, at) =>
        item[at + 1]?.text === "." && aliases.has(unquote(token.text)),
    );

    if (index > 0) {
      rewritten.push(punct(","));
    }

    if (!mentionsFrom) {
      rewritten.push(...byTableName(item));
      return;
    }

    const [{ expression, name }] = selectItems([ident("SELECT"), ...item]);
    const condition: Token[] = [];

    joining.forEach((conjunct, at) => {
      if (at > 0) condition.push(ident("AND"));
      condition.push(punct("("), ...byTableName(conjunct), punct(")"));
    });

    rewritten.push(
      punct("("),
      ident("SELECT"),
      ...byTableName(expression),
      ident("FROM"),
      ...fromClause,
      ...(condition.length > 0 ? [ident("WHERE"), ...condition] : []),
      ident("LIMIT"),
      { text: "1", type: "number" },
      punct(")"),
      ...(name
        ? [
            ident("AS"),
            { text: `"${name.replace(/"/g, '""')}"`, type: "qident" as const },
          ]
        : []),
    );
  });

  return [...tokens.slice(0, returning + 1), ...rewritten];
}

function splitOnTopLevelAnd(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  let between = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;

    if (depth === 0 && isWord(token, "CASE")) {
      const end = caseEnd(tokens, i);

      parts.at(-1)!.push(...tokens.slice(i, end + 1));
      i = end;
      continue;
    }

    if (depth === 0 && isWord(token, "BETWEEN")) {
      between = true;
    }

    // BETWEEN a AND b is one condition.
    if (depth === 0 && isWord(token, "AND") && between) {
      between = false;
      parts.at(-1)!.push(token);
    } else if (depth === 0 && isWord(token, "AND")) {
      parts.push([]);
    } else {
      parts.at(-1)!.push(token);
    }
  }

  return parts.filter((part) => part.length > 0);
}

/** `INSERT … SELECT … ON CONFLICT` needs a WHERE in SQLite's grammar. */
function addUpsertWhere(tokens: Token[]): Token[] {
  // Also `WITH … INSERT …`, as a data-modifying WITH leaves it: the parts
  // of the WITH are in parentheses, so the INSERT's own SELECT is the
  // first one at the top level.
  if (
    !isWord(tokens[0], "INSERT") &&
    !(isWord(tokens[0], "WITH") && topLevelIndex(tokens, "INSERT") !== -1)
  ) {
    return tokens;
  }

  const select = topLevelIndex(tokens, "SELECT");
  const conflict = topLevelSequence(tokens, ["ON", "CONFLICT"]);

  if (select === -1 || conflict === -1 || conflict < select) {
    return tokens;
  }

  const body = tokens.slice(select, conflict);

  if (topLevelIndex(body, "WHERE") !== -1) {
    return tokens;
  }

  let at = conflict;

  for (const word of ["GROUP", "ORDER", "LIMIT"]) {
    const index = topLevelIndex(body, word);

    if (index !== -1) {
      at = Math.min(at, select + index);
    }
  }

  return [
    ...tokens.slice(0, at),
    ident("WHERE"),
    ident("true"),
    ...tokens.slice(at),
  ];
}

/**
 * DELETE FROM t x USING u y WHERE …: SQLite has no USING, so the other
 * tables go into an EXISTS over the same conditions, which deletes the same
 * rows. (On Postgres the conditions on `x` stay on the deleted row itself,
 * and are checked again on a row another transaction changed meanwhile;
 * SQLite's one writer has no such row.)
 */
function rewriteDeleteUsing(tokens: Token[], sql: string): Token[] {
  if (!isWord(tokens[0], "DELETE") || !isWord(tokens[1], "FROM")) {
    return tokens;
  }

  const using = topLevelIndex(tokens, "USING");

  if (using === -1) {
    return tokens;
  }

  // RETURNING could name the USING tables, which the EXISTS hides.
  if (topLevelIndex(tokens, "RETURNING", using) !== -1) {
    throw new UnsupportedSqlError("DELETE … USING … RETURNING", sql);
  }

  const where = topLevelIndex(tokens, "WHERE", using);
  const from = tokens.slice(using + 1, where === -1 ? undefined : where);
  const conditions = where === -1 ? [ident("true")] : tokens.slice(where + 1);

  return [
    ...tokens.slice(0, using),
    ident("WHERE"),
    ident("EXISTS"),
    punct("("),
    ident("SELECT"),
    { text: "1", type: "number" },
    ident("FROM"),
    ...from,
    ident("WHERE"),
    ...conditions,
    punct(")"),
  ];
}

function rejectUnsupported(tokens: Token[], sql: string) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const word = upper(token);

    if (
      word === "ILIKE" ||
      (word === "SIMILAR" && isWord(tokens[i + 1], "TO"))
    ) {
      throw new UnsupportedSqlError(word, sql);
    }

    if (word === "LATERAL") {
      throw new UnsupportedSqlError("LATERAL", sql);
    }

    if (word === "DISTINCT" && isWord(tokens[i + 1], "ON")) {
      throw new UnsupportedSqlError("DISTINCT ON", sql);
    }

    if (
      token.type === "op" &&
      ["~", "~*", "!~", "!~*", "?|", "?&", "#>", "#>>"].includes(token.text)
    ) {
      throw new UnsupportedSqlError(`the ${token.text} operator`, sql);
    }

    if (
      [
        "DECLARE",
        "FETCH",
        "CLOSE",
        "LISTEN",
        "NOTIFY",
        "COPY",
        "VACUUM",
        "LOCK",
      ].includes(word) &&
      i === 0
    ) {
      throw new UnsupportedSqlError(word, sql);
    }
  }
}

/** x / y: Postgres refuses a division by zero, SQLite gives NULL. */
function rewriteDivision(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    if (out[i]!.type !== "op" || out[i]!.text !== "/") {
      continue;
    }

    const sign = out[i + 1]?.text === "-" || out[i + 1]?.text === "+";
    const start = i + 1;
    const end = operandEnd(out, sign ? i + 2 : i + 1, sql);
    const replacement = [
      ident("pg_nonzero"),
      punct("("),
      ...out.slice(start, end + 1),
      punct(")"),
    ];

    out.splice(start, end - start + 1, ...replacement);
  }

  return out;
}

/** a <@ b, a @> b (JSON containment, used by tests). */
function rewriteContainment(tokens: Token[], sql: string): Token[] {
  const out = [...tokens];

  for (let i = 0; i < out.length; i += 1) {
    const text = out[i]!.text;

    if (out[i]!.type !== "op" || (text !== "<@" && text !== "@>")) {
      continue;
    }

    const start = operandStart(out, i - 1, sql);
    const end = operandEnd(out, i + 1, sql);
    const left = out.slice(start, i);
    const right = out.slice(i + 1, end + 1);
    const [container, contained] =
      text === "@>" ? [left, right] : [right, left];
    const replacement = [
      ident("pg_json_contains"),
      punct("("),
      ...container,
      punct(","),
      ...contained,
      punct(")"),
    ];

    out.splice(start, end - start + 1, ...replacement);
    i = start + replacement.length - 1;
  }

  return out;
}

function render(tokens: Token[]): string {
  let sql = "";

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const previous = tokens[i - 1];

    if (
      previous &&
      !(
        token.text === "." ||
        previous.text === "." ||
        token.text === ")" ||
        previous.text === "(" ||
        token.text === "," ||
        (token.text === "(" &&
          (previous.type === "ident" || previous.type === "qident"))
      )
    ) {
      sql += " ";
    }

    sql += token.text;
  }

  return sql;
}

// ---------------------------------------------------------------- type hints

const BOOL_FUNCTIONS = new Set([
  "BOOL_OR",
  "BOOL_AND",
  "EVERY",
  "PG_TRY_ADVISORY_XACT_LOCK",
]);
const JSON_FUNCTIONS = new Set([
  "JSON_OBJECT",
  "JSONB_BUILD_OBJECT",
  "JSON_BUILD_OBJECT",
  "JSONB_SET",
  "TO_JSONB",
  "TO_JSON",
  "JSONB_AGG",
  "JSON_AGG",
  "ARRAY_AGG",
  "JSON_GROUP_ARRAY",
  "JSONB_STRIP_NULLS",
  "ROW_TO_JSON",
  "JSON_ARRAY",
]);
const DATE_FUNCTIONS = new Set(["NOW", "CURRENT_TIMESTAMP"]);
const FIRST_ARGUMENT_FUNCTIONS = new Set([
  "COALESCE",
  "NULLIF",
  "MAX",
  "MIN",
  "GREATEST",
  "LEAST",
]);
const BOOLEAN_OPERATORS = new Set([
  "=",
  "<>",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "<@",
  "@>",
]);

function categoryOfDeclaredType(type: string | null): TypeHint | null {
  if (!type) {
    return null;
  }

  const normalized = type.toUpperCase();

  if (normalized.includes("BOOL")) {
    return "bool";
  }

  if (normalized.includes("JSON") || normalized.endsWith("[]")) {
    return "json";
  }

  if (normalized.startsWith("TIMESTAMP") || normalized === "DATE") {
    return "date";
  }

  return null;
}

/** Index after the END that closes the CASE at `start`. */
function caseEnd(tokens: Token[], start: number): number {
  let depth = 0;

  for (let i = start; i < tokens.length; i += 1) {
    if (isWord(tokens[i], "CASE")) {
      depth += 1;
    } else if (isWord(tokens[i], "END")) {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  return tokens.length - 1;
}

function hintOf(tokens: Token[], schema: SchemaInfo | null): TypeHint | null {
  if (tokens.length === 0) {
    return null;
  }

  // ( … ) around the whole thing
  if (
    tokens[0]!.text === "(" &&
    closingParen(tokens, 0) === tokens.length - 1
  ) {
    const inner = tokens.slice(1, -1);

    if (isWord(inner[0], "SELECT")) {
      const items = selectItems(inner);

      return items[0] ? hintOf(items[0].expression, schema) : null;
    }

    return hintOf(inner, schema);
  }

  if (isWord(tokens[0], "NOT", "EXISTS")) {
    return "bool";
  }

  // A cast at the end decides.
  let depth = 0;
  let lastCast = -1;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.type === "punct" && (token.text === "(" || token.text === "[")) {
      depth += 1;
    } else if (
      token.type === "punct" &&
      (token.text === ")" || token.text === "]")
    ) {
      depth -= 1;
    } else if (depth === 0 && isWord(token, "CASE")) {
      i = caseEnd(tokens, i);
    } else if (depth === 0) {
      if (token.text === "::") {
        lastCast = i;
      } else if (
        (token.type === "op" && BOOLEAN_OPERATORS.has(token.text)) ||
        isWord(token, "IS", "IN", "LIKE", "BETWEEN", "AND", "OR", "NOT")
      ) {
        return "bool";
      }
    }
  }

  if (lastCast !== -1) {
    const { end, type } = castTypeEnd(tokens, lastCast + 1);

    if (end === tokens.length - 1) {
      return castCategory(type);
    }
  }

  depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.type === "punct" && (token.text === "(" || token.text === "[")) {
      depth += 1;
    } else if (
      token.type === "punct" &&
      (token.text === ")" || token.text === "]")
    ) {
      depth -= 1;
    } else if (depth === 0 && token.text === "->") {
      return "json";
    } else if (depth === 0 && isWord(token, "INTERVAL")) {
      return "date";
    }
  }

  const first = tokens[0]!;
  const word = upper(first);

  if (word === "TRUE" || word === "FALSE") {
    return tokens.length === 1 ? "bool" : null;
  }

  if (word === "ARRAY") {
    return "json";
  }

  if (word === "CASE") {
    const then = topLevelIndexInCase(tokens);

    if (then === -1) {
      return null;
    }

    let end = then + 1;
    let nested = 0;

    for (; end < tokens.length; end += 1) {
      const t = tokens[end]!;

      if (t.text === "(") nested += 1;
      else if (t.text === ")") nested -= 1;
      else if (nested === 0 && isWord(t, "CASE")) end = caseEnd(tokens, end);
      else if (nested === 0 && isWord(t, "WHEN", "ELSE", "END")) break;
    }

    return hintOf(tokens.slice(then + 1, end), schema);
  }

  if (
    (first.type === "ident" || first.type === "qident") &&
    tokens[1]?.text === "("
  ) {
    const close = closingParen(tokens, 1);

    if (
      close === tokens.length - 1 ||
      isWord(tokens[close + 1], "FILTER", "OVER")
    ) {
      if (BOOL_FUNCTIONS.has(word)) return "bool";
      if (JSON_FUNCTIONS.has(word)) return "json";
      if (DATE_FUNCTIONS.has(word)) return "date";

      if (FIRST_ARGUMENT_FUNCTIONS.has(word)) {
        for (const argument of splitTopLevel(tokens.slice(2, close))) {
          const hint = hintOf(argument, schema);

          if (hint) {
            return hint;
          }
        }
      }

      return null;
    }
  }

  if (word === "CURRENT_TIMESTAMP" && tokens.length === 1) {
    return "date";
  }

  // A column reference: a, t.a, "a", t."a"
  const last = tokens.at(-1)!;
  const isReference =
    (last.type === "ident" || last.type === "qident") &&
    tokens.every((token, index) =>
      index % 2 === 0
        ? token.type === "ident" || token.type === "qident"
        : token.text === ".",
    );

  if (isReference && schema) {
    return categoryOfDeclaredType(schema.columnType(unquote(last.text)));
  }

  return null;
}

function topLevelIndexInCase(tokens: Token[]): number {
  let nested = 0;

  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;

    if (t.text === "(") nested += 1;
    else if (t.text === ")") nested -= 1;
    else if (nested === 0 && isWord(t, "CASE")) i = caseEnd(tokens, i);
    else if (nested === 0 && isWord(t, "THEN")) return i;
  }

  return -1;
}

type SelectItem = { expression: Token[]; name: string | null };

const CLAUSE_ENDS = [
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "INTO",
  "FOR",
  "WINDOW",
];

/** The words a type in a cast is made of, so an alias after it is not one. */
const TYPE_NAME_WORDS = new Set([
  "BIGINT",
  "BOOL",
  "BOOLEAN",
  "BYTEA",
  "CHAR",
  "CHARACTER",
  "DATE",
  "DECIMAL",
  "DOUBLE",
  "FLOAT",
  "FLOAT4",
  "FLOAT8",
  "INT",
  "INT2",
  "INT4",
  "INT8",
  "INTEGER",
  "JSON",
  "JSONB",
  "NUMERIC",
  "PRECISION",
  "REAL",
  "SMALLINT",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "UUID",
  "VARCHAR",
  "VARYING",
  "WITH",
  "WITHOUT",
  "ZONE",
]);

/**
 * `SELECT x.col::text` with no alias: Postgres names the result column
 * `col`, SQLite would name it after the whole CAST it becomes. So such an
 * item of the statement's select list or RETURNING list gets `AS col`.
 */
function nameCastColumns(tokens: Token[]): Token[] {
  const returning = topLevelIndex(tokens, "RETURNING");
  const select = topLevelIndex(tokens, "SELECT");
  const start =
    returning !== -1 ? returning + 1 : select !== -1 ? select + 1 : -1;

  if (start === -1) {
    return tokens;
  }

  const first = isWord(tokens[start], "DISTINCT", "ALL") ? start + 1 : start;
  let end = tokens.length;

  if (returning === -1) {
    for (const word of CLAUSE_ENDS) {
      const index = topLevelIndex(tokens, word, first);

      if (index !== -1) {
        end = Math.min(end, index);
      }
    }
  }

  let changed = false;
  const items = splitTopLevel(tokens.slice(first, end)).map((item) => {
    const cast = item.findIndex((token) => token.text === "::");

    if (
      cast < 1 ||
      cast % 2 === 0 ||
      !item
        .slice(0, cast)
        .every((token, index) =>
          index % 2 === 0
            ? token.type === "ident" || token.type === "qident"
            : token.text === ".",
        ) ||
      !item
        .slice(cast + 1)
        .every(
          (token) =>
            (token.type === "ident" && TYPE_NAME_WORDS.has(upper(token))) ||
            token.text === "[" ||
            token.text === "]",
        )
    ) {
      return item;
    }

    changed = true;

    return [
      ...item,
      ident("AS"),
      {
        text: `"${unquote(item[cast - 1]!.text).replace(/"/g, '""')}"`,
        type: "qident" as const,
      },
    ];
  });

  if (!changed) {
    return tokens;
  }

  return [
    ...tokens.slice(0, first),
    ...items.flatMap((item, index) => [
      ...(index > 0 ? [punct(",")] : []),
      ...item,
    ]),
    ...tokens.slice(end),
  ];
}

/** The items of the select list (or RETURNING list) that begins the tokens. */
function selectItems(tokens: Token[], fromIndex = 1): SelectItem[] {
  let end = tokens.length;

  for (const word of CLAUSE_ENDS) {
    const index = topLevelIndex(tokens, word, fromIndex);

    if (index !== -1) {
      end = Math.min(end, index);
    }
  }

  let start = fromIndex;

  if (isWord(tokens[start], "DISTINCT", "ALL")) {
    start += 1;
  }

  return splitTopLevel(tokens.slice(start, end)).map((item) => {
    if (item.length === 0) {
      return { expression: item, name: null };
    }

    const last = item.at(-1)!;

    if (item.length >= 3 && isWord(item.at(-2), "AS")) {
      return { expression: item.slice(0, -2), name: unquote(last.text) };
    }

    const isName = last.type === "ident" || last.type === "qident";
    const before = item.at(-2);

    // expression alias, without AS: `count(*) total`, `u.email email`
    if (
      isName &&
      before &&
      before.text !== "." &&
      before.type !== "op" &&
      !isWord(
        before,
        "IS",
        "NOT",
        "AND",
        "OR",
        "THEN",
        "ELSE",
        "WHEN",
        "IN",
        "LIKE",
        "BETWEEN",
      ) &&
      !["END", "NULL", "TRUE", "FALSE"].includes(upper(last))
    ) {
      return { expression: item.slice(0, -1), name: unquote(last.text) };
    }

    // a bare column keeps its own name
    const isReference = item.every((token, index) =>
      index % 2 === 0
        ? token.type === "ident" || token.type === "qident"
        : token.text === ".",
    );

    return { expression: item, name: isReference ? unquote(last.text) : null };
  });
}

function computeHints(
  tokens: Token[],
  schema: SchemaInfo | null,
): Map<string, TypeHint> {
  const hints = new Map<string, TypeHint>();
  let items: SelectItem[] = [];
  const returning = topLevelIndex(tokens, "RETURNING");

  if (returning !== -1) {
    items = splitTopLevel(tokens.slice(returning + 1)).map(
      (item) => selectItems([ident("SELECT"), ...item])[0]!,
    );
  } else {
    const select = topLevelIndex(tokens, "SELECT");

    if (select !== -1) {
      items = selectItems(tokens, select + 1);
    }
  }

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    const hint = hintOf(item.expression, schema);

    if (hint) {
      hints.set(item.name, hint);
    }
  }

  return hints;
}

// --------------------------------------------------------------- entry point

const ADVISORY =
  /^\s*select\s+(pg_try_advisory_xact_lock|pg_advisory_xact_lock)\s*\(([\s\S]*)\)\s*(?:as\s+("?)([A-Za-z_][A-Za-z0-9_]*)\3)?\s*;?\s*$/i;

function classify(tokens: Token[]): StatementKind {
  const first = upper(tokens[0]);

  if (
    first === "BEGIN" ||
    (first === "START" && isWord(tokens[1], "TRANSACTION"))
  ) {
    return "begin";
  }

  if (first === "COMMIT" || first === "END") {
    return "commit";
  }

  if (first === "ROLLBACK" || first === "ABORT") {
    return "rollback";
  }

  if (first === "SELECT" || first === "VALUES") {
    return "read";
  }

  if (first === "WITH") {
    return tokens.some((token) =>
      isWord(token, "INSERT", "UPDATE", "DELETE", "REPLACE"),
    )
      ? "write"
      : "read";
  }

  return "write";
}

/**
 * Rewrites one Postgres statement for SQLite. `schema` is needed for
 * row_to_json and makes type hints for bare columns possible.
 */
export function rewriteSql(
  sql: string,
  schema: SchemaInfo | null = null,
): Rewritten {
  const advisory = ADVISORY.exec(sql);

  if (advisory) {
    const inner = rewriteSql(`SELECT ${advisory[2]!}`, schema);

    return {
      advisory: {
        column: advisory[4] ?? advisory[1]!.toLowerCase(),
        isTry: advisory[1]!.toLowerCase().startsWith("pg_try"),
      },
      hints: new Map(),
      kind: "advisory",
      sql: inner.sql,
    };
  }

  let original = tokenize(sql);

  // TRUNCATE [TABLE] t [CASCADE]: a DELETE, whose foreign keys cascade.
  if (isWord(original[0], "TRUNCATE")) {
    const rest = original
      .slice(isWord(original[1], "TABLE") ? 2 : 1)
      .filter(
        (token) =>
          !isWord(
            token,
            "ONLY",
            "CASCADE",
            "RESTRICT",
            "RESTART",
            "CONTINUE",
            "IDENTITY",
          ),
      );

    if (rest.some((token) => token.text === ",")) {
      throw new UnsupportedSqlError("TRUNCATE of several tables", sql);
    }

    original = [ident("DELETE"), ident("FROM"), ...rest];
  }

  const kind = classify(original);

  if (kind === "begin" || kind === "commit" || kind === "rollback") {
    // REPEATABLE READ and SERIALIZABLE read on one snapshot; see `snapshot`.
    const snapshot =
      kind === "begin" &&
      original.some(
        (token, index) =>
          isWord(token, "REPEATABLE", "SERIALIZABLE") &&
          isWord(original[index - 1], "LEVEL"),
      );

    return {
      hints: new Map(),
      kind,
      sql: kind.toUpperCase(),
      ...(snapshot ? { snapshot } : {}),
    };
  }

  // LOCK TABLE … IN … MODE: what it holds back is other writers until the
  // transaction ends, and here a transaction's write lock holds back every
  // other writer already. So it takes that lock, as a locking read does.
  if (isWord(original[0], "LOCK")) {
    return { hints: new Map(), kind: "locking-read", sql: "SELECT 1 WHERE 0" };
  }

  original = rewriteDeleteUsing(original, sql);
  rejectUnsupported(original, sql);

  const dataModifyingCte = splitDataModifyingCte(original, sql, schema);

  if (dataModifyingCte) {
    return dataModifyingCte;
  }

  const hints = computeHints(original, schema);
  let tokens = stripRowLocks(original);

  tokens = rewriteParenthesizedCompound(tokens);
  tokens = rewriteConflictConstraint(tokens, sql, schema);
  tokens = rewriteToRegclass(tokens);
  tokens = addTargetAs(tokens);
  tokens = rewriteRowToJson(tokens, sql, schema);
  tokens = rewriteExtract(tokens, sql);
  tokens = rewriteSpecialForms(tokens, sql);
  tokens = nameCastColumns(tokens);
  tokens = rewriteCasts(tokens, sql);
  tokens = rewriteIntervals(tokens, sql);
  tokens = rewriteAnyAll(tokens, sql);
  tokens = rewriteArrays(tokens, sql);
  tokens = rewriteContainment(tokens, sql);
  tokens = rewriteDivision(tokens, sql);
  tokens = rewriteNamesAndParams(tokens);
  tokens = addUpsertWhere(tokens);
  tokens = rewriteUpdateFromReturning(tokens);

  return {
    hints,
    kind: kind === "read" && hasRowLock(original) ? "locking-read" : kind,
    sql: render(tokens),
  };
}

/** The highest `$n` in the tokens, or 0. */
function highestParameter(tokens: Token[]): number {
  let highest = 0;

  for (const token of tokens) {
    if (token.type === "param") {
      highest = Math.max(highest, Number(token.text.slice(1)));
    }
  }

  return highest;
}

/** The table an INSERT, UPDATE or DELETE writes to. */
function dmlTable(body: Token[]): string | null {
  const at = isWord(body[0], "UPDATE") ? 1 : 2;
  const name = body[at + 1]?.text === "." ? body[at + 2] : body[at];

  return name ? unquote(name.text) : null;
}

/** A column name as a token, quoted unless it needs no quotes. */
function columnName(name: string): Token {
  return /^[a-z_][a-z0-9_]*$/.test(name)
    ? ident(name)
    : { text: `"${name.replace(/"/g, '""')}"`, type: "qident" };
}

/**
 * RETURNING `*` or `alias.*`, spelled out as the table's columns, so that
 * each returned column has a name the later statements can read it by.
 */
function expandReturningStar(
  body: Token[],
  returning: number,
  schema: SchemaInfo | null,
  sql: string,
): Token[] {
  const items = splitTopLevel(body.slice(returning + 1));

  if (!items.some((item) => item.at(-1)?.text === "*")) {
    return body;
  }

  const table = dmlTable(body);
  const columns = table ? schema?.tableColumns(table) : null;

  if (!columns) {
    throw new UnsupportedSqlError(
      "RETURNING * in a WITH, without the table's columns",
      sql,
    );
  }

  const expanded = items.flatMap((item) => {
    if (item.length === 1 && item[0]!.text === "*") {
      return columns.map(({ name }) => [columnName(name)]);
    }

    if (item.length === 3 && item[1]!.text === "." && item[2]!.text === "*") {
      return columns.map(({ name }) => [
        item[0]!,
        punct("."),
        columnName(name),
      ]);
    }

    return [item];
  });

  return [
    ...body.slice(0, returning + 1),
    ...expanded.flatMap((item, index) => [
      ...(index > 0 ? [punct(",")] : []),
      ...item,
    ]),
  ];
}

/**
 * A WITH with parts that insert, update or delete, such as
 * `WITH name AS (DELETE … RETURNING a, b) SELECT … FROM name`: SQLite has
 * no data-modifying CTEs. Each such part runs first, in order, as a
 * statement of its own (`preSteps`), with the parts before it as its WITH.
 * What it returns goes to the statements after it as JSON, in a parameter
 * appended after the statement's own; in them the part reads those rows. A
 * part with no RETURNING cannot be read on Postgres either, so it only
 * runs. The pool runs them all, and then the rest, in one transaction.
 *
 * `floor` is the highest parameter already taken, by the statement or by
 * the rows of a part before.
 */
function splitDataModifyingCte(
  tokens: Token[],
  sql: string,
  schema: SchemaInfo | null,
  floor = 0,
): Rewritten | null {
  if (!isWord(tokens[0], "WITH")) {
    return null;
  }

  const recursive = isWord(tokens[1], "RECURSIVE");
  // name [(columns)] AS ( body ) [, …]
  const ctes: { close: number; name: Token; open: number; start: number }[] =
    [];
  let at = recursive ? 2 : 1;

  for (;;) {
    const start = at;
    const name = tokens[at];
    let open = at + 1;

    if (tokens[open]?.text === "(") {
      open = closingParen(tokens, open) + 1;
    }

    if (
      !name ||
      !isWord(tokens[open], "AS") ||
      tokens[open + 1]?.text !== "("
    ) {
      return null;
    }

    const close = closingParen(tokens, open + 1);

    ctes.push({ close, name, open: open + 1, start });
    at = close + 1;

    if (tokens[at]?.text !== ",") {
      break;
    }

    at += 1;
  }

  const index = ctes.findIndex(({ open }) =>
    isWord(tokens[open + 1], "INSERT", "UPDATE", "DELETE"),
  );

  if (index === -1) {
    return null;
  }

  const part = ctes[index]!;
  const definition = (cte: (typeof ctes)[number]) =>
    tokens.slice(cte.start, cte.close + 1);
  const withClause = (definitions: Token[][]): Token[] =>
    definitions.length === 0
      ? []
      : [
          ident("WITH"),
          ...(recursive ? [ident("RECURSIVE")] : []),
          ...definitions.flatMap((tokensOfOne, position) => [
            ...(position > 0 ? [punct(",")] : []),
            ...tokensOfOne,
          ]),
        ];
  const before = ctes.slice(0, index).map(definition);
  const after = ctes.slice(index + 1).map(definition);
  const rest = tokens.slice(ctes.at(-1)!.close + 1);
  let body = tokens.slice(part.open + 1, part.close);
  const returning = topLevelIndex(body, "RETURNING");
  const highest = Math.max(floor, highestParameter(tokens));
  let rowsParameter: number | null = null;
  let readable: Token[][] = [...before, ...after];

  if (returning !== -1) {
    body = expandReturningStar(body, returning, schema, sql);

    const columns = splitTopLevel(body.slice(returning + 1)).map(
      (item) => selectItems([ident("SELECT"), ...item])[0]?.name ?? null,
    );

    if (columns.some((column) => column === null)) {
      throw new UnsupportedSqlError(
        "a RETURNING item without a name in a WITH",
        sql,
      );
    }

    rowsParameter = highest + 1;
    readable = [
      ...before,
      [
        part.name,
        punct("("),
        ...columns.flatMap((column, position) => [
          ...(position > 0 ? [punct(",")] : []),
          {
            text: `"${column!.replace(/"/g, '""')}"`,
            type: "qident" as const,
          },
        ]),
        punct(")"),
        ident("AS"),
        punct("("),
        ident("SELECT"),
        ...columns.flatMap((_, position) => [
          ...(position > 0 ? [punct(",")] : []),
          ident("json_extract"),
          punct("("),
          ident("value"),
          punct(","),
          { text: `'$[${String(position)}]'`, type: "string" as const },
          punct(")"),
        ]),
        ident("FROM"),
        ident("json_each"),
        punct("("),
        { text: `$${String(rowsParameter)}`, type: "param" },
        punct(")"),
        punct(")"),
      ],
      ...after,
    ];
  }

  const stepTokens = [...withClause(before), ...body];
  const step = rewriteSql(render(stepTokens), schema);

  if (step.preSteps) {
    throw new UnsupportedSqlError(
      "a data-modifying WITH inside a data-modifying WITH",
      sql,
    );
  }

  const remainder = [...withClause(readable), ...rest];
  const main =
    splitDataModifyingCte(remainder, sql, schema, rowsParameter ?? highest) ??
    rewriteSql(render(remainder), schema);

  return {
    hints: main.hints,
    kind: "write",
    parameters: main.parameters ?? highestParameter(remainder),
    preSteps: [
      {
        parameters: highestParameter(stepTokens),
        rowsParameter,
        sql: step.sql,
      },
      ...(main.preSteps ?? []),
    ],
    sql: main.sql,
  };
}

/**
 * The same, cached by SQL text: each distinct statement is rewritten once.
 */
export function createRewriteCache(
  schema: () => SchemaInfo | null,
  limit = 4000,
) {
  const cache = new Map<string, Rewritten>();

  const rewrite = (sql: string): Rewritten => {
    const found = cache.get(sql);

    if (found) {
      return found;
    }

    const rewritten = rewriteSql(sql, schema());

    if (cache.size >= limit) {
      cache.delete(cache.keys().next().value!);
    }

    cache.set(sql, rewritten);
    return rewritten;
  };

  // Rewrites carry what the schema was when they were made, so a change to
  // the schema empties the cache.
  return Object.assign(rewrite, { clear: () => cache.clear() });
}
