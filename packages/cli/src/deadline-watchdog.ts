/** A final process bound for operations that ignore the run's abort signal. */
export function startDeadlineWatchdog(
  delayMs = 10_000,
  exit: (code: number) => void = (code) => process.exit(code),
): ReturnType<typeof setTimeout> {
  return setTimeout(() => exit(3), delayMs);
}
