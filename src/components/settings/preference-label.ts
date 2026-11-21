// The accessible name of a notification preference checkbox: the row's
// visible label, then which envelopes it covers.
export function preferenceCheckboxLabel(event: {
  kind: string;
  label: string;
}): string {
  return `${event.label}, for my envelopes`;
}
