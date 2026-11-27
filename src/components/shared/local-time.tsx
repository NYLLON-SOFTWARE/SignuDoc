"use client";

import { useSyncExternalStore } from "react";

import { formatLocalTime, type LocalTimeFormat } from "@/lib/local-time";

// The time zone can change while a page is open: a laptop taken somewhere
// else. Coming back to the window is when that shows.
function subscribe(onChange: () => void) {
  window.addEventListener("focus", onChange);

  return () => window.removeEventListener("focus", onChange);
}

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// The server does not know the reader's time zone, and the browser's first
// render has to match the server's. Both write UTC, and the browser then
// writes the time again in its own zone.
function serverTimeZone() {
  return "UTC";
}

/**
 * A moment, in Unix seconds, shown in the reader's own time zone. Hovering
 * shows the same moment in UTC.
 */
export function LocalTime({
  format = "dateTime",
  timestamp,
}: {
  format?: LocalTimeFormat;
  timestamp: number;
}) {
  const timeZone = useSyncExternalStore(
    subscribe,
    browserTimeZone,
    serverTimeZone,
  );
  const iso = new Date(timestamp * 1000).toISOString();

  return (
    <time dateTime={iso} title={iso}>
      {formatLocalTime(timestamp, format, timeZone)}
    </time>
  );
}
