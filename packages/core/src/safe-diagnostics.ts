/** Keep only Playwright progress lines that cannot contain an action argument. */
export function safeCallLog(error: unknown): readonly string[] {
  const message = error instanceof Error ? error.message : "";
  const lines = message.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Call log:");
  if (start < 0) return [];
  const safe = [
    /^waiting for element to be (?:visible|enabled|stable|editable)(?:(?:, | and )(?:enabled|stable|editable))*$/,
    /^element is (?:visible|enabled|stable|editable)(?:(?:, | and )(?:enabled|stable|editable))*$/,
    /^scrolling into view if needed$/,
    /^done scrolling$/,
    /^performing click action$/,
    /^retrying click action(?:, attempt #\d+)?$/,
    /^waiting for scheduled navigations to finish$/,
    /^navigations have finished$/,
    /^element was detached from the DOM, retrying$/,
  ];
  return lines
    .slice(start + 1)
    .filter((line) => line.trim())
    .slice(0, 8)
    .map((line) => {
      const entry = line.trim().replace(/^-\s*/, "");
      return safe.some((pattern) => pattern.test(entry))
        ? entry
        : "[action argument redacted]";
    });
}
