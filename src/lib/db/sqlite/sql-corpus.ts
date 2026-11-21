// Collects every SQL statement the app sends, from its source, so that the
// SQLite rewriter can be checked against all of them (rewrite.test.ts).
//
// A statement is the SQL argument of a call to `.query(…)`, or the second
// argument of `queryOne(…)` / `queryMany(…)`, in any non-test file under
// src/ or scripts/. Interpolations are resolved when they are constants
// (in the same file or imported from another) or literals; anything else
// needs a stand-in in sql-corpus-exceptions.ts, so a new kind of dynamic
// SQL fails the test instead of going unchecked.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { STAND_INS } from "./sql-corpus-exceptions.ts";

export type CorpusEntry = {
  /** Path from the repository root. */
  file: string;
  line: number;
  /** The statement, with every interpolation resolved. */
  sql: string;
  /** Interpolations that could not be resolved (the test fails on any). */
  unresolved: string[];
  /** Stand-ins from sql-corpus-exceptions.ts that were used. */
  standIns: string[];
};

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "test-support"]);

function isSourceFile(file: string): boolean {
  return (
    /\.(ts|tsx)$/.test(file) &&
    !/\.(test|dbtest|spec)\.tsx?$/.test(file) &&
    !file.endsWith(".d.ts")
  );
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      // The SQLite adapter itself speaks SQLite, not Postgres.
      if (
        !SKIPPED_DIRECTORIES.has(entry) &&
        !full.endsWith(path.join("lib", "db", "sqlite"))
      ) {
        files.push(...listSourceFiles(full));
      }
    } else if (isSourceFile(full)) {
      files.push(full);
    }
  }

  return files;
}

/** The database tests and the end-to-end specs. */
function listTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);

      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") walk(full);
      } else if (/\.(dbtest|spec)\.ts$/.test(entry)) {
        files.push(full);
      }
    }
  };

  walk(path.join(root, "src"));
  walk(path.join(root, "e2e"));
  return files;
}

function normalizeExpression(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

class SourceIndex {
  private readonly sources = new Map<string, ts.SourceFile>();

  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get(file: string): ts.SourceFile | null {
    let source = this.sources.get(file);

    if (!source) {
      let text: string;

      try {
        text = readFileSync(file, "utf8");
      } catch {
        return null;
      }

      source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      this.sources.set(file, source);
    }

    return source;
  }

  /** The initializer of a top-level `const name = …` in a file. */
  constInitializer(file: string, name: string): ts.Expression | null {
    const source = this.get(file);

    if (!source) {
      return null;
    }

    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            return declaration.initializer;
          }
        }
      }
    }

    // Imported from another file of the app.
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }

      for (const element of statement.importClause.namedBindings.elements) {
        if (element.name.text !== name) {
          continue;
        }

        const specifier = statement.moduleSpecifier.text;
        const target = specifier.startsWith("@/")
          ? path.join(this.root, "src", specifier.slice(2))
          : specifier.startsWith(".")
            ? path.resolve(path.dirname(file), specifier)
            : null;

        if (!target) {
          return null;
        }

        for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
          if (/\.(ts|tsx)$/.test(candidate)) {
            const found = this.constInitializer(
              candidate,
              (element.propertyName ?? element.name).text,
            );

            if (found) {
              return found;
            }
          }
        }
      }
    }

    return null;
  }
}

type Resolved = { standIns: string[]; text: string; unresolved: string[] };

/** A `const` declared in a block around the expression, before it. */
function localConstInitializer(
  identifier: ts.Identifier,
): ts.Expression | null {
  for (
    let node: ts.Node | undefined = identifier.parent;
    node;
    node = node.parent
  ) {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) {
      continue;
    }

    for (const statement of node.statements) {
      if (statement.pos > identifier.pos) {
        break;
      }

      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === identifier.text &&
            declaration.initializer
          ) {
            return declaration.initializer;
          }
        }
      }
    }
  }

  return null;
}

function resolveExpression(
  expression: ts.Expression,
  file: string,
  index: SourceIndex,
  depth = 0,
): Resolved {
  const source = expression.getSourceFile();
  const expressionKey = normalizeExpression(expression.getText(source));
  // "path/from/root.ts: expression" is a stand-in for that file only, and
  // comes before one for the expression anywhere.
  const scoped = Object.keys(STAND_INS).find((candidate) => {
    const at = candidate.indexOf(": ");

    return (
      at > 0 &&
      candidate.slice(at + 2) === expressionKey &&
      source.fileName.endsWith(`/${candidate.slice(0, at)}`)
    );
  });
  const key = scoped ?? expressionKey;
  const standIn = STAND_INS[key];

  if (standIn !== undefined) {
    return {
      standIns: [key],
      text: typeof standIn === "function" ? standIn() : standIn,
      unresolved: [],
    };
  }

  if (depth > 8) {
    return { standIns: [], text: "", unresolved: [key] };
  }

  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression)
  ) {
    return resolveExpression(expression.expression, file, index, depth + 1);
  }

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return { standIns: [], text: expression.text, unresolved: [] };
  }

  if (ts.isNumericLiteral(expression)) {
    return { standIns: [], text: expression.text, unresolved: [] };
  }

  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    const standIns: string[] = [];
    const unresolved: string[] = [];

    for (const span of expression.templateSpans) {
      const part = resolveExpression(span.expression, file, index, depth + 1);

      text += part.text + span.literal.text;
      standIns.push(...part.standIns);
      unresolved.push(...part.unresolved);
    }

    return { standIns, text, unresolved };
  }

  if (ts.isIdentifier(expression)) {
    const initializer =
      localConstInitializer(expression) ??
      index.constInitializer(file, expression.text);

    if (initializer) {
      return resolveExpression(
        initializer,
        initializer.getSourceFile().fileName,
        index,
        depth + 1,
      );
    }
  }

  // `lock ? "FOR UPDATE" : ""`: the first branch, which has more to check.
  if (ts.isConditionalExpression(expression)) {
    return resolveExpression(expression.whenTrue, file, index, depth + 1);
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveExpression(expression.left, file, index, depth + 1);
    const right = resolveExpression(expression.right, file, index, depth + 1);

    return {
      standIns: [...left.standIns, ...right.standIns],
      text: left.text + right.text,
      unresolved: [...left.unresolved, ...right.unresolved],
    };
  }

  return { standIns: [], text: "", unresolved: [key] };
}

/** The SQL argument of a call, if the call sends SQL. */
function sqlArgument(call: ts.CallExpression): ts.Expression | null {
  const callee = call.expression;

  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "query") {
    return call.arguments[0] ?? null;
  }

  if (
    ts.isIdentifier(callee) &&
    (callee.text === "queryOne" || callee.text === "queryMany")
  ) {
    return call.arguments[1] ?? null;
  }

  return null;
}

/** Every SQL statement in the app's source. */
export function collectSqlCorpus(
  root: string,
  { includeTests = false }: { includeTests?: boolean } = {},
): CorpusEntry[] {
  const index = new SourceIndex(root);
  const entries: CorpusEntry[] = [];
  const files = [
    ...listSourceFiles(path.join(root, "src")),
    ...listSourceFiles(path.join(root, "scripts")),
    ...(includeTests ? listTestFiles(root) : []),
  ].sort();

  for (const file of files) {
    const source = index.get(file)!;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const argument = sqlArgument(node);

        if (argument) {
          // `cond ? "a" : "b"` sends either.
          const candidates = ts.isConditionalExpression(argument)
            ? [argument.whenTrue, argument.whenFalse]
            : [argument];

          for (const candidate of candidates) {
            const resolved = resolveExpression(candidate, file, index);
            const isDynamicArgument =
              resolved.unresolved.length === 1 &&
              resolved.unresolved[0] ===
                normalizeExpression(candidate.getText(source));

            // `db.query(text, values)` inside a helper passes SQL along.
            if (isDynamicArgument && ts.isIdentifier(candidate)) {
              continue;
            }

            entries.push({
              file: path.relative(root, file),
              line:
                source.getLineAndCharacterOfPosition(candidate.getStart(source))
                  .line + 1,
              sql: resolved.text,
              standIns: resolved.standIns,
              unresolved: resolved.unresolved,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return entries;
}
