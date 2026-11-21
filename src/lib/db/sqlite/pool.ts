// The SQLite backend: a pool with the shape of the part of pg.Pool the app
// uses (query, connect, end), so no call site changes. Postgres SQL is
// rewritten (rewrite.ts), Postgres functions are registered (functions.ts),
// values are converted both ways so that what the app reads is exactly what
// pg returns, and transactions are serialized: one writer, in one process.
//
// See docs/design/database-backends.md, "Transactions and concurrency".
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { isSqliteUrl, openSqliteDatabase, sqliteFilePath } from "./open.ts";
import {
  CATALOG_VIEWS_SQL,
  formatTimestamp,
  registerFunctions,
} from "./functions.ts";
import {
  createRewriteCache,
  type Rewritten,
  type SchemaInfo,
  type StatementKind,
  type TypeHint,
} from "./rewrite.ts";
import { readSchemaInfo } from "./schema.ts";

export { isSqliteUrl };

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export type SqliteQueryResult<R = Record<string, unknown>> = {
  command: string;
  fields: { name: string }[];
  rowCount: number;
  rows: R[];
};

type QueryInput = string | { text: string; values?: readonly unknown[] };

/** A Postgres-style error: `code` is the SQLSTATE the app checks. */
export class SqliteDatabaseError extends Error {
  code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SqliteDatabaseError";
    this.code = code;
  }
}

function sqlStateFor(error: { errcode?: number; message: string }): string {
  const message = error.message;

  if (/no such table/i.test(message)) return "42P01";
  if (/no such column|has no column named/i.test(message)) return "42703";

  switch (error.errcode) {
    case 2067: // SQLITE_CONSTRAINT_UNIQUE
    case 1555: // SQLITE_CONSTRAINT_PRIMARYKEY
      return "23505";
    case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
      return "23503";
    case 275: // SQLITE_CONSTRAINT_CHECK
    case 1811: // SQLITE_CONSTRAINT_TRIGGER (a trigger that refuses a row)
      return "23514";
    case 1299: // SQLITE_CONSTRAINT_NOTNULL
      return "23502";
    case 5: // SQLITE_BUSY
    case 6: // SQLITE_LOCKED
    case 261:
    case 517:
      return "55P03";
    default:
      return "XX000";
  }
}

/**
 * The message Postgres would give, with SQLite's own after it: what a
 * constraint error says is matched on by code that reports it.
 */
function postgresMessage(code: string, message: string): string {
  const name = /constraint failed: ([A-Za-z_][A-Za-z0-9_]*)$/.exec(
    message,
  )?.[1];

  switch (code) {
    case "23505":
      return `duplicate key value violates unique constraint (${message})`;
    case "23503":
      return `insert or update violates foreign key constraint (${message})`;
    case "23514":
      // A trigger's own words stand as they are.
      return /CHECK constraint failed/.test(message)
        ? `new row violates check constraint "${name ?? "unknown"}" (${message})`
        : message;
    case "23502":
      return `null value violates not-null constraint (${message})`;
    default:
      return message;
  }
}

function toDatabaseError(error: unknown): unknown {
  if (error instanceof SqliteDatabaseError || !(error instanceof Error)) {
    return error;
  }

  if ((error as { code?: unknown }).code !== "ERR_SQLITE_ERROR") {
    // A JavaScript error from a registered function, or a TypeError from
    // binding a value: reported as it is.
    return error;
  }

  const code = sqlStateFor(error as { errcode?: number; message: string });

  return new SqliteDatabaseError(
    postgresMessage(code, error.message),
    code,
    error,
  );
}

// ------------------------------------------------------------------ values

/** A parameter as SQLite stores it. */
export function toSqliteValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return formatTimestamp(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  )
    return value;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "object") return JSON.stringify(value);

  return String(value);
}

type Convert = (value: unknown) => unknown;

function asBoolean(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== BigInt(0);
  if (typeof value === "string")
    return (
      value === "1" ||
      value.toLowerCase() === "true" ||
      value.toLowerCase() === "t"
    );

  return Boolean(value);
}

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asDate(value: unknown): unknown {
  return typeof value === "string" ? new Date(value) : value;
}

function asPlain(value: unknown): unknown {
  return value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

function categoryOf(type: string | null): TypeHint | null {
  if (!type) return null;

  const normalized = type.toUpperCase();

  if (normalized.includes("BOOL")) return "bool";
  if (normalized.includes("JSON") || normalized.endsWith("[]")) return "json";
  if (normalized.startsWith("TIMESTAMP") || normalized === "DATE")
    return "date";

  return null;
}

function converterFor(category: TypeHint | null): Convert {
  switch (category) {
    case "bool":
      return asBoolean;
    case "json":
      return asJson;
    case "date":
      return asDate;
    default:
      return asPlain;
  }
}

// ------------------------------------------------------------------- locks

type Holder = {
  /** What it is waiting for, if anything. */
  waiting:
    | null
    | { kind: "mutex"; advisory: boolean }
    | { kind: "advisory"; key: string };
};

class WriteLock {
  owner: Holder | null = null;
  private readonly queue: { holder: Holder; resolve: () => void }[] = [];

  acquire(holder: Holder, timeoutMs: number): Promise<void> {
    if (!this.owner) {
      this.owner = holder;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const entry = {
        holder,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);

        if (index !== -1) {
          this.queue.splice(index, 1);
        }

        reject(
          new SqliteDatabaseError(
            `Waited ${String(timeoutMs)} ms for the SQLite write lock. A transaction has held the database that long, or a write was made through the pool from inside a transaction, which waits for itself.`,
            "55P03",
          ),
        );
      }, timeoutMs);

      this.queue.push(entry);
    });
  }

  release(holder: Holder) {
    if (this.owner !== holder) {
      return;
    }

    const next = this.queue.shift();

    this.owner = next?.holder ?? null;
    next?.resolve();
  }
}

// ---------------------------------------------------------------- the file

type Prepared = {
  converters: Convert[] | null;
  names: string[] | null;
  statement: StatementSync;
};

type ClientState = "idle" | "pending" | "active" | "failed";

/** One database file, shared by every pool on it in this process. */
class SqliteFile {
  readonly writer: DatabaseSync;
  readonly reader: DatabaseSync;
  readonly lock = new WriteLock();
  readonly advisoryHolders = new Map<string, Holder>();
  readonly waitingHolders = new Set<Holder>();
  private readonly keyWaiters = new Set<{ key: string; wake: () => void }>();
  private readonly prepared = new WeakMap<
    DatabaseSync,
    Map<string, Prepared>
  >();
  private schema: SchemaInfo | null = null;
  private currentNow: string | null = null;
  readonly rewrite: ReturnType<typeof createRewriteCache>;
  references = 0;

  readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.writer = openSqliteDatabase(connectionString);
    this.reader = openSqliteDatabase(connectionString, { readOnly: true });

    for (const database of [this.writer, this.reader]) {
      registerFunctions(database, {
        // Every wait counts for both views: on SQLite the one write lock
        // stands in for Postgres's row and advisory locks alike, so a
        // transaction Postgres would hold up at an advisory lock is held up
        // here at the write lock, one statement earlier.
        lockWaiters: () => this.waitingHolders.size,
        now: () => this.currentNow ?? formatTimestamp(new Date()),
      });
      database.exec(CATALOG_VIEWS_SQL);
      this.prepared.set(database, new Map());
    }

    this.rewrite = createRewriteCache(() => this.schemaInfo());
  }

  close() {
    this.writer.close();
    this.reader.close();
  }

  /**
   * A connection of its own for a transaction that reads on one snapshot
   * (REPEATABLE READ or SERIALIZABLE): its reads run in one SQLite read
   * transaction, which sees the file as it was at the first of them, as a
   * Postgres snapshot does, while writes go on meanwhile.
   */
  openSnapshot(): DatabaseSync {
    const database = openSqliteDatabase(this.connectionString, {
      readOnly: true,
    });

    registerFunctions(database, {
      lockWaiters: () => this.waitingHolders.size,
      now: () => this.currentNow ?? formatTimestamp(new Date()),
    });
    database.exec(CATALOG_VIEWS_SQL);
    this.prepared.set(database, new Map());
    database.exec("BEGIN");

    return database;
  }

  closeSnapshot(database: DatabaseSync) {
    try {
      if (database.isTransaction) {
        database.exec("COMMIT");
      }
    } finally {
      this.prepared.delete(database);
      database.close();
    }
  }

  /** Column types, read once (and again after a schema change). */
  schemaInfo(): SchemaInfo {
    if (this.schema) {
      return this.schema;
    }

    this.schema = readSchemaInfo(this.writer);
    return this.schema;
  }

  private prepare(database: DatabaseSync, sql: string): Prepared {
    const cache = this.prepared.get(database)!;
    let found = cache.get(sql);

    if (!found) {
      found = {
        converters: null,
        names: null,
        statement: database.prepare(sql),
      };

      if (cache.size > 2000) {
        cache.clear();
      }

      cache.set(sql, found);
    }

    return found;
  }

  /** Runs one statement, synchronously, and converts what it returns. */
  run(
    database: DatabaseSync,
    rewritten: Pick<Rewritten, "hints" | "sql">,
    values: readonly unknown[],
    now: string | null,
  ): SqliteQueryResult {
    const parameters = values.map(toSqliteValue) as never[];
    const command = (
      /^\s*([A-Za-z]+)/.exec(rewritten.sql)?.[1] ?? ""
    ).toUpperCase();

    this.currentNow = now;

    try {
      const prepared = this.prepare(database, rewritten.sql);
      const { statement } = prepared;

      if (!prepared.converters) {
        const columns = statement.columns();

        prepared.names = columns.map((column) => column.name);
        prepared.converters = columns.map((column) =>
          converterFor(
            categoryOf(column.type) ??
              (column.type ? null : (rewritten.hints.get(column.name) ?? null)),
          ),
        );
      }

      if (prepared.names!.length === 0) {
        const { changes } = statement.run(...parameters);

        if (/^\s*(CREATE|ALTER|DROP)\b/i.test(rewritten.sql)) {
          this.schema = null;
          this.rewrite.clear();

          for (const connection of [this.writer, this.reader]) {
            this.prepared.get(connection)!.clear();
          }
        }

        return { command, fields: [], rowCount: Number(changes), rows: [] };
      }

      const names = prepared.names!;
      const converters = prepared.converters;
      const rows = (
        statement.all(...parameters) as Record<string, unknown>[]
      ).map((row) => {
        const converted: Record<string, unknown> = {};

        for (let i = 0; i < names.length; i += 1) {
          const name = names[i]!;

          converted[name] = converters[i]!(row[name]);
        }

        return converted;
      });

      return {
        command,
        fields: names.map((name) => ({ name })),
        rowCount: rows.length,
        rows,
      };
    } catch (error) {
      throw toDatabaseError(error);
    } finally {
      this.currentNow = null;
    }
  }

  /**
   * A statement on the writer, inside a transaction the caller holds. A
   * data-modifying WITH runs its DML first, part by part, and hands the rows
   * of each on as JSON.
   */
  runWrite(
    rewritten: Rewritten,
    values: readonly unknown[],
    now: string | null,
  ): SqliteQueryResult {
    if (!rewritten.preSteps) {
      return this.run(this.writer, rewritten, values, now);
    }

    const bound: unknown[] = [...values];
    const first = (count: number) =>
      Array.from({ length: count }, (_, index) => bound[index] ?? null);

    for (const step of rewritten.preSteps) {
      const result = this.run(
        this.writer,
        { hints: new Map(), sql: step.sql },
        first(step.parameters),
        now,
      );

      if (step.rowsParameter !== null) {
        bound[step.rowsParameter - 1] = JSON.stringify(
          result.rows.map((row) =>
            result.fields.map(({ name }) => toSqliteValue(row[name])),
          ),
        );
      }
    }

    return this.run(
      this.writer,
      rewritten,
      first(rewritten.parameters ?? bound.length),
      now,
    );
  }

  setWaiting(holder: Holder, waiting: Holder["waiting"]) {
    holder.waiting = waiting;

    if (waiting) {
      this.waitingHolders.add(holder);
    } else {
      this.waitingHolders.delete(holder);
    }
  }

  async acquireWriteLock(
    holder: Holder,
    timeoutMs: number,
    forAdvisory = false,
  ) {
    const owner = this.lock.owner;

    // The owner waits for a key this one holds: each would wait forever.
    if (
      owner &&
      owner !== holder &&
      owner.waiting?.kind === "advisory" &&
      this.advisoryHolders.get(owner.waiting.key) === holder
    ) {
      throw new SqliteDatabaseError("deadlock detected", "40P01");
    }

    this.setWaiting(holder, { advisory: forAdvisory, kind: "mutex" });

    try {
      await this.lock.acquire(holder, timeoutMs);
    } finally {
      this.setWaiting(holder, null);
    }
  }

  /** Waits until no one else holds `key`. */
  async waitForKey(holder: Holder, key: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const owner = this.advisoryHolders.get(key);

      if (!owner || owner === holder) {
        return;
      }

      // The holder of the key waits for the write lock this one holds.
      if (owner.waiting?.kind === "mutex" && this.lock.owner === holder) {
        throw new SqliteDatabaseError("deadlock detected", "40P01");
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        throw new SqliteDatabaseError(
          `Waited ${String(timeoutMs)} ms for an advisory lock.`,
          "55P03",
        );
      }

      this.setWaiting(holder, { key, kind: "advisory" });

      try {
        await new Promise<void>((resolve) => {
          const waiter = {
            key,
            wake: () => {
              clearTimeout(timer);
              this.keyWaiters.delete(waiter);
              resolve();
            },
          };
          const timer = setTimeout(waiter.wake, remaining);

          this.keyWaiters.add(waiter);
        });
      } finally {
        this.setWaiting(holder, null);
      }
    }
  }

  releaseKeys(holder: Holder, keys: Set<string>) {
    for (const key of keys) {
      if (this.advisoryHolders.get(key) === holder) {
        this.advisoryHolders.delete(key);
      }

      for (const waiter of [...this.keyWaiters]) {
        if (waiter.key === key) {
          waiter.wake();
        }
      }
    }

    keys.clear();
  }

  /** The key an advisory lock statement names, from its arguments. */
  advisoryKey(rewritten: Rewritten, values: readonly unknown[]): string {
    const result = this.run(this.reader, rewritten, values, null);

    return JSON.stringify(Object.values(result.rows[0] ?? {}));
  }
}

const REGISTRY_KEY = Symbol.for("signudoc.sqliteFiles");
const registry: Map<string, SqliteFile> =
  ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as
    Map<string, SqliteFile> | undefined) ?? new Map();

(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;

function openFile(connectionString: string): SqliteFile {
  const key = sqliteFilePath(connectionString);
  let file = registry.get(key);

  if (!file) {
    file = new SqliteFile(connectionString);
    registry.set(key, file);
  }

  file.references += 1;
  return file;
}

function closeFile(file: SqliteFile) {
  file.references -= 1;

  if (file.references <= 0) {
    registry.delete(sqliteFilePath(file.connectionString));
    file.close();
  }
}

function normalizeQuery(
  input: QueryInput,
  values?: readonly unknown[],
): { text: string; values: readonly unknown[] } {
  if (typeof input === "string") {
    return { text: input, values: values ?? [] };
  }

  return { text: input.text, values: values ?? input.values ?? [] };
}

/** SQL from Kysely (Better Auth), already SQLite SQL: classified only. */
function rawStatement(sql: string): Rewritten {
  const first = (/^\s*([A-Za-z]+)/.exec(sql)?.[1] ?? "").toUpperCase();
  let kind: StatementKind = "write";

  if (first === "BEGIN") kind = "begin";
  else if (first === "COMMIT" || first === "END") kind = "commit";
  else if (first === "ROLLBACK") kind = "rollback";
  else if (
    first === "SELECT" ||
    (first === "WITH" && !/\b(insert|update|delete|replace)\b/i.test(sql))
  )
    kind = "read";

  return { hints: new Map(), kind, sql };
}

function emptyResult(command: string): SqliteQueryResult {
  return { command, fields: [], rowCount: 0, rows: [] };
}

// --------------------------------------------------------------- the client

/** A connection from the pool: what withTransaction gets. */
export class SqliteClient implements Holder {
  waiting: Holder["waiting"] = null;
  state: ClientState = "idle";
  private transactionNow: string | null = null;
  /** A REPEATABLE READ or SERIALIZABLE transaction's reads (openSnapshot). */
  private snapshot: DatabaseSync | null = null;
  private readonly keys = new Set<string>();
  private released = false;
  private tail: Promise<unknown> = Promise.resolve();

  private readonly file: SqliteFile;
  private readonly lockTimeoutMs: number;

  constructor(file: SqliteFile, lockTimeoutMs: number) {
    this.file = file;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  query<R = Record<string, unknown>>(
    input: QueryInput,
    values?: readonly unknown[],
  ): Promise<SqliteQueryResult<R>> {
    const query = normalizeQuery(input, values);

    return this.execute(this.file.rewrite(query.text), query.values) as Promise<
      SqliteQueryResult<R>
    >;
  }

  /** For Kysely: SQLite SQL, not rewritten. */
  queryRaw(
    sql: string,
    values: readonly unknown[],
  ): Promise<SqliteQueryResult> {
    return this.execute(rawStatement(sql), values);
  }

  release() {
    if (this.released) {
      return;
    }

    this.released = true;
    this.finish(false);
  }

  private get inTransaction() {
    return this.state !== "idle";
  }

  /**
   * Takes the write lock and starts the transaction, at its first write or
   * locking read (SELECT … FOR UPDATE/SHARE).
   */
  private async activate(forAdvisory = false) {
    if (this.state === "active") {
      return;
    }

    await this.file.acquireWriteLock(this, this.lockTimeoutMs, forAdvisory);

    try {
      this.file.writer.exec("BEGIN IMMEDIATE");
    } catch (error) {
      this.file.lock.release(this);
      throw toDatabaseError(error);
    }

    this.transactionNow ??= formatTimestamp(new Date());
    this.state = "active";
  }

  /** Ends the transaction; `commit` false rolls back. */
  private finish(commit: boolean): string {
    let command = commit ? "COMMIT" : "ROLLBACK";

    try {
      if (this.state === "active" && this.file.writer.isTransaction) {
        if (commit) {
          try {
            this.file.writer.exec("COMMIT");
          } catch (error) {
            this.file.writer.exec("ROLLBACK");
            throw toDatabaseError(error);
          }
        } else {
          this.file.writer.exec("ROLLBACK");
        }
      } else if (this.state === "failed") {
        if (this.file.writer.isTransaction && this.file.lock.owner === this) {
          this.file.writer.exec("ROLLBACK");
        }

        // COMMIT of a failed transaction rolls back, as on Postgres.
        command = "ROLLBACK";
      }
    } finally {
      if (this.file.lock.owner === this) {
        this.file.lock.release(this);
      }

      this.file.releaseKeys(this, this.keys);
      this.state = "idle";
      this.transactionNow = null;
      this.endSnapshot();
    }

    return command;
  }

  private endSnapshot() {
    const snapshot = this.snapshot;

    this.snapshot = null;

    if (snapshot) {
      this.file.closeSnapshot(snapshot);
    }
  }

  /**
   * A statement of the transaction failed. As on Postgres, the transaction
   * is over: only ROLLBACK is accepted from here. Its changes are undone
   * and its locks freed now, so whatever waits for them goes on even
   * before the caller gets round to ROLLBACK.
   */
  private abort() {
    this.state = "failed";

    try {
      if (this.file.lock.owner === this && this.file.writer.isTransaction) {
        this.file.writer.exec("ROLLBACK");
      }
    } finally {
      if (this.file.lock.owner === this) {
        this.file.lock.release(this);
      }

      this.file.releaseKeys(this, this.keys);
    }
  }

  private failed(): never {
    throw new SqliteDatabaseError(
      "current transaction is aborted, commands ignored until end of transaction block",
      "25P02",
    );
  }

  /**
   * Statements run in the order they were issued, one at a time, as on a pg
   * client, so that a caller that does not await each one cannot make the
   * second wait on the write lock behind the first.
   */
  private execute(
    rewritten: Rewritten,
    values: readonly unknown[],
  ): Promise<SqliteQueryResult> {
    const run = this.tail.then(() => this.executeNow(rewritten, values));

    this.tail = run.catch(() => undefined);
    return run;
  }

  private async executeNow(
    rewritten: Rewritten,
    values: readonly unknown[],
  ): Promise<SqliteQueryResult> {
    if (this.released) {
      throw new Error("Client was released and cannot be used.");
    }

    switch (rewritten.kind) {
      case "begin":
        if (this.state === "idle") {
          this.state = "pending";
          // now() is the time the transaction began, as on Postgres.
          this.transactionNow = formatTimestamp(new Date());

          if (rewritten.snapshot) {
            this.snapshot = this.file.openSnapshot();
          }
        }

        return emptyResult("BEGIN");
      case "commit":
        return emptyResult(this.finish(true));
      case "rollback":
        return emptyResult(this.finish(false));
      case "advisory":
        return this.advisory(rewritten, values);
      default:
        break;
    }

    if (this.state === "failed") {
      this.failed();
    }

    if (!this.inTransaction) {
      return runOutsideTransaction(
        this.file,
        this,
        rewritten,
        values,
        this.lockTimeoutMs,
      );
    }

    // Before its first write or locking read, a transaction has nothing of
    // its own to see: a plain read sees what is committed, without taking
    // the lock, exactly as a read in a Postgres READ COMMITTED transaction
    // takes no row lock. So a transaction that has only read does not hold
    // up writes made meanwhile through the pool. A REPEATABLE READ one reads
    // on its snapshot.
    if (this.state === "pending" && rewritten.kind === "read") {
      try {
        return this.file.run(
          this.snapshot ?? this.file.reader,
          rewritten,
          values,
          this.transactionNow,
        );
      } catch (error) {
        this.state = "failed";
        throw error;
      }
    }

    await this.activate();

    try {
      return this.file.runWrite(rewritten, values, this.transactionNow);
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  private async advisory(
    rewritten: Rewritten,
    values: readonly unknown[],
  ): Promise<SqliteQueryResult> {
    if (this.state === "failed") {
      this.failed();
    }

    const { column, isTry } = rewritten.advisory!;
    const key = this.file.advisoryKey(rewritten, values);
    let value: boolean | string = "";

    if (isTry) {
      const owner = this.file.advisoryHolders.get(key);

      value = !owner || owner === this;

      if (value && this.inTransaction) {
        this.file.advisoryHolders.set(key, this);
        this.keys.add(key);
      }
    } else if (this.inTransaction) {
      // Every blocking user of a key holds the write lock first, so two of
      // them never wait on each other (see the design document).
      await this.activate(true);
      await this.file.waitForKey(this, key, this.lockTimeoutMs);
      this.file.advisoryHolders.set(key, this);
      this.keys.add(key);
    } else {
      await this.file.waitForKey(this, key, this.lockTimeoutMs);
    }

    return {
      command: "SELECT",
      fields: [{ name: column }],
      rowCount: 1,
      rows: [{ [column]: value }],
    };
  }
}

/** A statement outside any transaction. */
async function runOutsideTransaction(
  file: SqliteFile,
  holder: Holder,
  rewritten: Rewritten,
  values: readonly unknown[],
  lockTimeoutMs: number,
): Promise<SqliteQueryResult> {
  const now = formatTimestamp(new Date());

  // Reads see everything committed, without waiting, as on Postgres.
  if (rewritten.kind === "read" || rewritten.kind === "locking-read") {
    return file.run(file.reader, rewritten, values, now);
  }

  await file.acquireWriteLock(holder, lockTimeoutMs);

  try {
    if (!rewritten.preSteps) {
      return file.run(file.writer, rewritten, values, now);
    }

    // Statements that must land together.
    file.writer.exec("BEGIN IMMEDIATE");

    try {
      const result = file.runWrite(rewritten, values, now);

      file.writer.exec("COMMIT");
      return result;
    } catch (error) {
      if (file.writer.isTransaction) {
        file.writer.exec("ROLLBACK");
      }

      throw toDatabaseError(error);
    }
  } finally {
    file.lock.release(holder);
  }
}

// ----------------------------------------------------------------- the pool

export type SqlitePoolOptions = {
  /** How long a statement waits for the write lock (default 30 s). */
  lockTimeoutMs?: number;
  /** Called once the pool is ended. */
  onEnd?: () => void | Promise<void>;
};

export class SqlitePool {
  private readonly file: SqliteFile;
  private ended = false;
  readonly lockTimeoutMs: number;
  readonly options: { connectionString: string };
  private readonly poolOptions: SqlitePoolOptions;

  constructor(connectionString: string, poolOptions: SqlitePoolOptions = {}) {
    this.poolOptions = poolOptions;
    this.file = openFile(connectionString);
    this.options = { connectionString };
    this.lockTimeoutMs =
      poolOptions.lockTimeoutMs ??
      (Number(process.env.SQLITE_LOCK_TIMEOUT_MS) || DEFAULT_LOCK_TIMEOUT_MS);
  }

  query<R = Record<string, unknown>>(
    input: QueryInput,
    values?: readonly unknown[],
  ): Promise<SqliteQueryResult<R>> {
    const query = normalizeQuery(input, values);
    const rewritten = this.file.rewrite(query.text);

    if (
      rewritten.kind === "begin" ||
      rewritten.kind === "commit" ||
      rewritten.kind === "rollback"
    ) {
      return Promise.reject(
        new Error("Transaction statements need a client from connect()."),
      );
    }

    if (rewritten.kind === "advisory") {
      // Outside a transaction an advisory lock ends with the statement.
      const client = new SqliteClient(this.file, this.lockTimeoutMs);

      return client
        .query<R>(query.text, query.values)
        .finally(() => client.release());
    }

    return runOutsideTransaction(
      this.file,
      { waiting: null },
      rewritten,
      query.values,
      this.lockTimeoutMs,
    ) as Promise<SqliteQueryResult<R>>;
  }

  /** Raw SQLite SQL (Kysely), outside a transaction. */
  queryRaw(
    sql: string,
    values: readonly unknown[],
  ): Promise<SqliteQueryResult> {
    return runOutsideTransaction(
      this.file,
      { waiting: null },
      rawStatement(sql),
      values,
      this.lockTimeoutMs,
    );
  }

  async connect(): Promise<SqliteClient> {
    if (this.ended) {
      throw new Error("Cannot use a pool after calling end on the pool");
    }

    return new SqliteClient(this.file, this.lockTimeoutMs);
  }

  /** The read-only connection, for a consistent snapshot (backups). */
  get readerDatabase(): DatabaseSync {
    return this.file.reader;
  }

  /** Column types by table (backups). */
  get schema(): SchemaInfo {
    return this.file.schemaInfo();
  }

  // pg.Pool's counters. The app tells a pool from a client by them
  // ("totalCount" in database), and opens a transaction for a pool.
  get totalCount(): number {
    return 1;
  }

  get idleCount(): number {
    return this.file.lock.owner ? 0 : 1;
  }

  get waitingCount(): number {
    return this.file.waitingHolders.size;
  }

  on(): this {
    return this;
  }

  async end(): Promise<void> {
    if (this.ended) {
      return;
    }

    this.ended = true;
    closeFile(this.file);
    await this.poolOptions.onEnd?.();
  }
}

export function isSqlitePool(value: unknown): value is SqlitePool {
  return value instanceof SqlitePool;
}
