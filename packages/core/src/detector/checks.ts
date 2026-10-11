import type { BrowserSignal } from "./signals.js";

export type DetectionCheck =
  | BrowserSignal["kind"]
  | "error_message"
  | "stuck_loading"
  | "empty_content"
  | "broken_value";

/** One suspected bug on one step. Detections flag a step; they never fail it. */
export interface Detection {
  readonly check: DetectionCheck;
  /** browser: a deterministic signal; text: an exact string; model: Jev. */
  readonly source: "browser" | "text" | "model";
  readonly message: string;
  readonly url?: string;
  readonly status?: number;
  /** The model's probability for its check. */
  readonly probability?: number;
  /** The model's expected severity, from 0 (works) to 3 (blocking). */
  readonly severity?: number;
}

/**
 * `check:pattern` or `pattern`. A pattern is a substring of the detection's
 * message or URL, or `re:` and a case-sensitive regular expression.
 */
export interface AllowRule {
  readonly check: DetectionCheck | null;
  readonly test: (text: string) => boolean;
  readonly source: string;
}

const CHECKS: readonly DetectionCheck[] = [
  "console_error",
  "uncaught_exception",
  "unhandled_rejection",
  "http_error",
  "error_message",
  "stuck_loading",
  "empty_content",
  "broken_value",
];

/** Noise every app produces; extend per project with `--detect-allow`. */
export const DEFAULT_ALLOW = [
  "http_error:/favicon.ico",
  "console_error:re:^ResizeObserver loop",
] as const;

export function parseAllowRule(text: string): AllowRule {
  const match = /^([a-z_]+):(.+)$/u.exec(text);
  const named = match && CHECKS.includes(match[1] as DetectionCheck);
  const check = named ? (match[1] as DetectionCheck) : null;
  const pattern = named ? match[2]! : text;
  if (!pattern.trim()) throw new Error("An allow rule needs a pattern.");
  if (pattern.startsWith("re:")) {
    const compiled = new RegExp(pattern.slice(3), "u");
    return { check, test: (value) => compiled.test(value), source: text };
  }
  return { check, test: (value) => value.includes(pattern), source: text };
}

export function allowed(
  detection: Detection,
  rules: readonly AllowRule[],
): boolean {
  const text = `${detection.message} ${detection.url ?? ""}`;
  return rules.some(
    (rule) =>
      (rule.check === null || rule.check === detection.check) &&
      rule.test(text),
  );
}

export function signalDetection(signal: BrowserSignal): Detection {
  return {
    check: signal.kind,
    source: "browser",
    message: signal.message,
    ...(signal.url ? { url: signal.url } : {}),
    ...(signal.status === undefined ? {} : { status: signal.status }),
  };
}

/**
 * Exact strings that only leak from code: a missing value printed by
 * JavaScript, or a template the renderer never filled. Fuzzy cases, such as
 * a blank price, are left to the model.
 */
const LEAKS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "undefined", pattern: /(?<![\w-])undefined(?![\w-])/u },
  { label: "NaN", pattern: /(?<![\w-])NaN(?![\w-])/u },
  { label: "[object Object]", pattern: /\[object Object\]/u },
  { label: "Invalid Date", pattern: /\bInvalid Date\b/u },
  { label: "template", pattern: /\{\{\s*[\w.$[\]]+\s*\}\}/u },
  { label: "template", pattern: /\$\{\s*[\w.$[\]]+\s*\}/u },
];
const CONTEXT = 40;

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(text.length, index + length + CONTEXT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function textDetections(text: string): Detection[] {
  const found: Detection[] = [];
  for (const leak of LEAKS) {
    const match = leak.pattern.exec(text);
    if (!match) continue;
    found.push({
      check: "broken_value",
      source: "text",
      message: `Page shows ${leak.label}: "${excerpt(text, match.index, match[0].length)}"`,
    });
  }
  return found;
}

/** One detection per check and message within a step. */
export function uniqueDetections(
  detections: readonly Detection[],
): Detection[] {
  const seen = new Set<string>();
  return detections.filter((detection) => {
    const key = `${detection.check}\u0000${detection.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
