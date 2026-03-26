export function resolveShellState<T extends string>(
  value: string | string[] | null | undefined,
  states: readonly T[],
  fallback: T,
): T {
  const normalizedValue = Array.isArray(value) ? value[0] : value;

  if (normalizedValue && states.includes(normalizedValue as T)) {
    return normalizedValue as T;
  }

  return fallback;
}
