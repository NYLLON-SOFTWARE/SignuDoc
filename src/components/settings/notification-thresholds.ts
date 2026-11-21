// A whole number of days from 0 to 60, or null when the text is not one.
export function parseDays(text: string): number | null {
  if (text.trim() === "") {
    return null;
  }

  const value = Number(text);

  return Number.isInteger(value) && value >= 0 && value <= 60 ? value : null;
}
