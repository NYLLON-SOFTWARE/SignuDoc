export function getClientIpAddress(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  if (forwardedFor) {
    return forwardedFor;
  }

  return (
    headers.get("cf-connecting-ip")?.trim() ??
    headers.get("x-real-ip")?.trim() ??
    null
  );
}

export function getRequestUserAgent(headers: Headers): string | null {
  return headers.get("user-agent")?.trim() ?? null;
}

export function getRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
