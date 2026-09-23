export type ProcessSignal = "SIGINT" | "SIGTERM";

/** Coordinates cancellation until the run outcome becomes irrevocable. */
export function createInterruptState() {
  const controller = new AbortController();
  let accepting = true;
  let interrupted: ProcessSignal | null = null;
  return {
    signal: controller.signal,
    request(signal: ProcessSignal) {
      if (!accepting) return;
      interrupted ??= signal;
      controller.abort();
    },
    commit() {
      accepting = false;
    },
    exitCode(fallback: number) {
      return interrupted === "SIGINT"
        ? 130
        : interrupted === "SIGTERM"
          ? 143
          : fallback;
    },
  };
}
