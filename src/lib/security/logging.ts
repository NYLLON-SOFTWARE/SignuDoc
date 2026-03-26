type SecurityLogLevel = "error" | "info" | "warn";

type SecurityLogInput = {
  category: string;
  ipAddress?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  path?: string;
  userId?: string | null;
};

const TOKEN_PATH_PATTERNS = [
  /^\/sign\/[^/]+/i,
  /^\/api\/signing\/[^/]+/i,
  /^\/api\/download\/[^/]+/i,
] as const;

function normalizeLoggedPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }

  try {
    return new URL(path).pathname;
  } catch {
    return path;
  }
}

function getConsoleMethod(level: SecurityLogLevel) {
  if (level === "info") {
    return console.info;
  }

  if (level === "warn") {
    return console.warn;
  }

  return console.error;
}

export function redactSensitivePath(path: string): string {
  const normalizedPath = normalizeLoggedPath(path);

  for (const pattern of TOKEN_PATH_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return normalizedPath.replace(pattern, (match) => {
        const segments = match.split("/");

        if (segments.length < 3) {
          return match;
        }

        segments[segments.length - 1] = "[redacted]";

        return segments.join("/");
      });
    }
  }

  return normalizedPath;
}

export function logSecurityEvent(
  level: SecurityLogLevel,
  input: SecurityLogInput,
): void {
  const consoleMethod = getConsoleMethod(level);
  const payload = {
    category: input.category,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
    path: input.path ? redactSensitivePath(input.path) : null,
    userId: input.userId ?? null,
  };

  consoleMethod(`[security] ${input.message}`, payload);
}

export function logRouteError(
  error: unknown,
  input: Omit<SecurityLogInput, "message"> & {
    message: string;
  },
): void {
  logSecurityEvent("error", input);
  console.error(error);
}
