// What the rewriter and the result conversion need to know about the
// schema: declared column types, and the columns of named constraints.
import type { DatabaseSync } from "node:sqlite";

import type { SchemaInfo } from "./rewrite.ts";

const CONSTRAINT =
  /constraint\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1\s+(?:unique|primary\s+key)\s*\(([^)]*)\)/gi;

export function readSchemaInfo(database: DatabaseSync): SchemaInfo {
  const tables = new Map<string, { name: string; type: string }[]>();
  const typesByColumn = new Map<string, Set<string>>();
  const constraints = new Map<string, string[]>();
  const rows = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string; sql: string | null }[];

  for (const { name, sql } of rows) {
    const columns = (
      database
        .prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)
        .all() as {
        name: string;
        type: string;
      }[]
    ).map((column) => ({ name: column.name, type: column.type }));

    tables.set(name, columns);

    for (const column of columns) {
      const types = typesByColumn.get(column.name) ?? new Set<string>();

      types.add(column.type.toUpperCase());
      typesByColumn.set(column.name, types);
    }

    for (const match of (sql ?? "").matchAll(CONSTRAINT)) {
      constraints.set(
        match[2]!,
        match[3]!
          .split(",")
          .map((column) => column.trim().replace(/^"|"$/g, "")),
      );
    }
  }

  return {
    columnType: (name) => {
      const types = typesByColumn.get(name);

      return types && types.size === 1 ? [...types][0]! : null;
    },
    constraintColumns: (name) => constraints.get(name) ?? null,
    tableColumns: (table) => tables.get(table) ?? null,
  };
}
