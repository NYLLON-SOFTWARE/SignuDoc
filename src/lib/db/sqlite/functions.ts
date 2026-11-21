// SQL functions with Postgres names, registered on every SQLite connection
// the app opens, so the app's SQL runs unchanged. See
// docs/design/database-backends.md.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type SqlValue = null | number | bigint | string | Uint8Array;

export type FunctionContext = {
  /** now(): the statement's or the transaction's time, ISO text. */
  now(): string;
  /** How many clients wait on a lock, of any kind or for advisory ones. */
  lockWaiters(kind: "all" | "advisory"): number;
};

/** The one text form of a timestamp: text order is time order. */
export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function toNumber(value: SqlValue): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed === "") {
      return null;
    }

    const parsed = Number(trimmed);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/** Postgres rounds a cast to an integer half away from zero. */
export function pgInt(value: SqlValue): number | bigint | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) {
    const parsed = BigInt(value.trim());

    return parsed >= BigInt(Number.MIN_SAFE_INTEGER) &&
      parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : parsed;
  }

  const number = toNumber(value);

  if (number === null) {
    if (typeof value === "string") {
      throw new Error(`invalid input syntax for type integer: "${value}"`);
    }

    return null;
  }

  return Math.sign(number) * Math.round(Math.abs(number));
}

/** Seconds since the epoch, from ISO text or from a number of seconds. */
export function epochOf(value: SqlValue): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const time = Date.parse(value);

    return Number.isNaN(time) ? null : time / 1000;
  }

  return null;
}

const INTERVAL_UNITS: Record<string, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  millisecond: 1,
  minute: 60_000,
  second: 1000,
  week: 7 * 86_400_000,
};

/** t + interval '<n> <unit>' (sign -1 for minus), on ISO text. */
export function intervalAdd(
  value: SqlValue,
  interval: string,
  sign: number,
): string | number | null {
  if (value === null) {
    return null;
  }

  let total = 0;
  const pattern = /(-?\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let match: RegExpExecArray | null;
  let matched = false;

  while ((match = pattern.exec(interval))) {
    const unit = match[2]!.toLowerCase().replace(/s$/, "");
    const size = INTERVAL_UNITS[unit];

    if (size === undefined) {
      throw new Error(`Unsupported interval unit: ${match[2]!}`);
    }

    total += Number(match[1]) * size;
    matched = true;
  }

  if (!matched) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  if (typeof value === "number" || typeof value === "bigint") {
    // epoch seconds
    return Number(value) + (sign * total) / 1000;
  }

  const time = Date.parse(String(value));

  if (Number.isNaN(time)) {
    throw new Error(
      `invalid input syntax for type timestamp: "${String(value)}"`,
    );
  }

  return formatTimestamp(new Date(time + sign * total));
}

/** greatest() and least() ignore NULLs, as in Postgres. */
function extreme(direction: 1 | -1) {
  return (...values: SqlValue[]): SqlValue => {
    let best: SqlValue = null;

    for (const value of values) {
      if (value === null) {
        continue;
      }

      if (best === null || (direction === 1 ? value > best : value < best)) {
        best = value;
      }
    }

    return best;
  };
}

function textOf(value: SqlValue): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Uint8Array
    ? Buffer.from(value).toString("utf8")
    : String(value);
}

function bytesOf(value: SqlValue): Buffer | null {
  if (value === null) {
    return null;
  }

  return value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), "utf8");
}

/** jsonb_set(target, '{a,0,b}', value) */
export function jsonbSet(
  target: SqlValue,
  path: SqlValue,
  value: SqlValue,
  createMissing: SqlValue = 1,
): string | null {
  if (target === null || path === null || value === null) {
    return null;
  }

  const document: unknown = JSON.parse(String(target));
  const keys = String(path)
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((key) => key.trim().replace(/^"|"$/g, ""));
  const replacement: unknown = JSON.parse(String(value));
  let node: unknown = document;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const last = i === keys.length - 1;

    if (Array.isArray(node)) {
      let index = Number(key);

      if (!Number.isInteger(index)) {
        return JSON.stringify(document);
      }

      if (index < 0) {
        index += node.length;
      }

      if (last) {
        if (index >= 0 && index < node.length) {
          node[index] = replacement;
        } else if (createMissing) {
          node.push(replacement);
        }
      } else {
        node = node[index];
      }
    } else if (node && typeof node === "object") {
      const object = node as Record<string, unknown>;

      if (last) {
        if (key in object || createMissing) {
          object[key] = replacement;
        }
      } else {
        node = object[key];
      }
    } else {
      break;
    }
  }

  return JSON.stringify(document);
}

/** a @> b for JSON values: b is contained in a. */
export function jsonContains(container: unknown, contained: unknown): boolean {
  if (Array.isArray(container)) {
    if (!Array.isArray(contained)) {
      return container.some((item) => jsonContains(item, contained));
    }

    return contained.every((item) =>
      container.some((candidate) => jsonContains(candidate, item)),
    );
  }

  if (container && typeof container === "object") {
    if (
      !contained ||
      typeof contained !== "object" ||
      Array.isArray(contained)
    ) {
      return false;
    }

    return Object.entries(contained).every(
      ([key, value]) =>
        key in container &&
        jsonContains((container as Record<string, unknown>)[key], value),
    );
  }

  return container === contained;
}

function parseJsonValue(value: SqlValue): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return typeof value === "bigint" ? Number(value) : value;
}

/** A stable 52-bit number for hashtextextended (only used as a lock key). */
function hashText(text: SqlValue, seed: SqlValue): number {
  const digest = createHash("sha256")
    .update(`${String(seed)}:${textOf(text) ?? ""}`)
    .digest();

  return digest.readUIntBE(0, 6) - 2 ** 47;
}

const TRUNCATE_UNITS = [
  "second",
  "minute",
  "hour",
  "day",
  "month",
  "year",
] as const;

function dateTrunc(unit: SqlValue, value: SqlValue): string | number | null {
  if (unit === null || value === null) {
    return null;
  }

  const name = String(unit).toLowerCase();

  if (
    !(TRUNCATE_UNITS as readonly string[]).includes(name) &&
    name !== "week"
  ) {
    throw new Error(`Unsupported date_trunc unit: ${name}`);
  }

  const isEpoch = typeof value === "number" || typeof value === "bigint";
  const date = isEpoch
    ? new Date(Number(value) * 1000)
    : new Date(String(value));
  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  const keep = {
    day: 3,
    hour: 4,
    minute: 5,
    month: 2,
    second: 6,
    week: 3,
    year: 1,
  }[name]!;
  const kept = parts.map((part, index) =>
    index < keep ? part : index === 2 ? 1 : 0,
  );
  let truncated = Date.UTC(
    kept[0]!,
    kept[1]!,
    kept[2]!,
    kept[3]!,
    kept[4]!,
    kept[5]!,
  );

  if (name === "week") {
    const weekday = (new Date(truncated).getUTCDay() + 6) % 7;

    truncated -= weekday * 86_400_000;
  }

  return isEpoch ? truncated / 1000 : formatTimestamp(new Date(truncated));
}

function extractField(field: SqlValue, value: SqlValue): number | null {
  if (field === null || value === null) {
    return null;
  }

  const isEpoch = typeof value === "number" || typeof value === "bigint";
  const date = isEpoch
    ? new Date(Number(value) * 1000)
    : new Date(String(value));

  switch (String(field).toLowerCase()) {
    case "epoch":
      return date.getTime() / 1000;
    case "year":
      return date.getUTCFullYear();
    case "month":
      return date.getUTCMonth() + 1;
    case "day":
      return date.getUTCDate();
    case "hour":
      return date.getUTCHours();
    case "minute":
      return date.getUTCMinutes();
    case "second":
      return date.getUTCSeconds() + date.getUTCMilliseconds() / 1000;
    case "dow":
      return date.getUTCDay();
    default:
      throw new Error(`Unsupported EXTRACT field: ${String(field)}`);
  }
}

/** Registers the functions on one connection. */
export function registerFunctions(
  database: DatabaseSync,
  context: FunctionContext,
) {
  const define = (
    name: string,
    fn: (...args: SqlValue[]) => SqlValue | boolean | undefined,
    deterministic = false,
  ) => {
    database.function(
      name,
      { deterministic, varargs: true },
      (...args: SqlValue[]) => {
        const result = fn(...args);

        return typeof result === "boolean"
          ? result
            ? 1
            : 0
          : (result ?? null);
      },
    );
  };

  // The divisor of every division (rewrite.ts), passed through unchanged:
  // integers arrive as BigInt, so an integer stays one and 7 / 2 is still 3.
  database.function(
    "pg_nonzero",
    { deterministic: true, useBigIntArguments: true },
    (value: SqlValue) => {
      if (value === 0 || value === BigInt(0)) {
        throw Object.assign(new Error("division by zero"), { code: "22012" });
      }

      return value;
    },
  );
  define("now", () => context.now());
  define("gen_random_uuid", () => randomUUID());
  define("pg_advisory_xact_lock", () => "");
  define("pg_try_advisory_xact_lock", () => true);
  define("hashtextextended", (text, seed) => hashText(text, seed ?? 0), true);
  define("pg_int", (value) => pgInt(value), true);
  define("pg_epoch", (value) => epochOf(value), true);
  define("pg_extract", (field, value) => extractField(field, value), true);
  define(
    "pg_interval_add",
    (value, interval, sign) =>
      intervalAdd(value, String(interval), Number(sign ?? 1)),
    true,
  );
  define("date_trunc", (unit, value) => dateTrunc(unit, value), true);
  define("greatest", extreme(1), true);
  define("least", extreme(-1), true);
  define(
    "pg_left",
    (text, count) => {
      const value = textOf(text);
      const n = toNumber(count);

      if (value === null || n === null) return null;

      const chars = [...value];

      return (
        n >= 0
          ? chars.slice(0, n)
          : chars.slice(0, Math.max(0, chars.length + n))
      ).join("");
    },
    true,
  );
  define(
    "pg_right",
    (text, count) => {
      const value = textOf(text);
      const n = toNumber(count);

      if (value === null || n === null) return null;

      const chars = [...value];

      return (
        n >= 0 ? chars.slice(Math.max(0, chars.length - n)) : chars.slice(-n)
      ).join("");
    },
    true,
  );
  define(
    "pg_regexp_substring",
    (text, pattern) => {
      const value = textOf(text);

      if (value === null || pattern === null) return null;

      const match = new RegExp(String(pattern)).exec(value);

      if (!match) return null;

      return match.length > 1 ? (match[1] ?? null) : match[0];
    },
    true,
  );
  define(
    "encode",
    (value, format) => {
      const bytes = bytesOf(value);

      if (bytes === null) return null;

      const name = String(format).toLowerCase();

      if (name !== "hex" && name !== "base64") {
        throw new Error(`Unsupported encoding: ${name}`);
      }

      return bytes.toString(name);
    },
    true,
  );
  define(
    "decode",
    (value, format) => {
      if (value === null) return null;

      const name = String(format).toLowerCase();

      if (name !== "hex" && name !== "base64") {
        throw new Error(`Unsupported encoding: ${name}`);
      }

      return Buffer.from(String(value), name);
    },
    true,
  );
  define(
    "sha256",
    (value) => {
      const bytes = bytesOf(value);

      return bytes === null
        ? null
        : createHash("sha256").update(bytes).digest();
    },
    true,
  );
  define(
    "digest",
    (value, algorithm) => {
      const bytes = bytesOf(value);

      return bytes === null
        ? null
        : createHash(String(algorithm)).update(bytes).digest();
    },
    true,
  );
  define(
    "jsonb_set",
    (target, path, value, create) => jsonbSet(target, path, value, create ?? 1),
    true,
  );
  define(
    "pg_json_contains",
    (container, contained) =>
      container === null || contained === null
        ? null
        : jsonContains(parseJsonValue(container), parseJsonValue(contained)),
    true,
  );
  define(
    "pg_jsonb_typeof",
    (value) => {
      if (value === null) {
        return null;
      }

      if (typeof value === "number" || typeof value === "bigint") {
        return "number";
      }

      const parsed = parseJsonValue(value) as unknown;

      if (parsed === null) {
        return "null";
      }

      return Array.isArray(parsed)
        ? "array"
        : typeof parsed === "object"
          ? "object"
          : typeof parsed === "string"
            ? "string"
            : typeof parsed === "number"
              ? "number"
              : "boolean";
    },
    true,
  );
  define(
    "pg_json_bool",
    (value) => (value === null ? null : JSON.stringify(Boolean(Number(value)))),
    true,
  );
  define(
    "cardinality",
    (value) =>
      value === null ? null : (JSON.parse(String(value)) as unknown[]).length,
    true,
  );
  define(
    "array_length",
    (value) => {
      if (value === null) return null;

      const length = (JSON.parse(String(value)) as unknown[]).length;

      // Postgres says NULL, not 0, for an empty array.
      return length === 0 ? null : length;
    },
    true,
  );
  define("current_database", () => "signudoc");
  define("pg_lock_waiters", (kind) =>
    context.lockWaiters(kind === "advisory" ? "advisory" : "all"),
  );
}

/**
 * Postgres's two views of who is waiting, answered from the pool's own lock
 * table, so tests that ask Postgres run unchanged. Per connection (TEMP).
 */
export const CATALOG_VIEWS_SQL = `
  CREATE TEMP VIEW IF NOT EXISTS pg_stat_activity AS
    WITH RECURSIVE waiting(n) AS (
      SELECT 1 WHERE pg_lock_waiters('all') >= 1
      UNION ALL SELECT n + 1 FROM waiting WHERE n < pg_lock_waiters('all')
    )
    SELECT 'Lock' AS wait_event_type, current_database() AS datname,
      'active' AS state, n AS pid
    FROM waiting;
  CREATE TEMP VIEW IF NOT EXISTS pg_locks AS
    WITH RECURSIVE waiting(n) AS (
      SELECT 1 WHERE pg_lock_waiters('advisory') >= 1
      UNION ALL SELECT n + 1 FROM waiting WHERE n < pg_lock_waiters('advisory')
    )
    SELECT 'advisory' AS locktype, 0 AS granted, n AS pid
    FROM waiting;
`;
