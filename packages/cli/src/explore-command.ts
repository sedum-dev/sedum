import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type {
  BrowserPage,
  BrowserSession,
  ExploreAction,
  ExploreFailure,
  ExploreMode,
  ExploreResult,
  OracleOptions,
  ProviderCall,
  TraceEntry,
} from "@sedum-dev/core";

export interface ExploreCommandOptions {
  readonly url: string;
  readonly steps: number;
  readonly seed?: number;
  readonly mode: ExploreMode;
  readonly out: string;
  readonly shrink: boolean;
  readonly headed: boolean;
  readonly allowDestructive: boolean;
  /** More origins whose HTTP 5xx responses count, such as an API host. */
  readonly watchOrigins?: readonly string[];
  /** Report 4xx answers to submissions (see OracleOptions). */
  readonly rejectedSubmits?: boolean;
  /** Console errors matching these regular expressions are ignored. */
  readonly ignoreConsole?: readonly string[];
  /** Union Jev's safety judgment with the destructive keyword list. */
  readonly strictSafety?: boolean;
  /** A Playwright storage-state file whose cookies sign the browser in. */
  readonly cookies?: string;
  readonly signal?: AbortSignal;
  readonly write: (text: string) => void;
}

export interface ReplayCommandOptions {
  readonly trace: string;
  readonly headed: boolean;
  readonly write: (text: string) => void;
}

export const EXPLORE_MODES: readonly ExploreMode[] = [
  "guided",
  "heuristic",
  "random",
];

export function exploreMode(value: string): ExploreMode {
  if (!EXPLORE_MODES.includes(value as ExploreMode))
    throw new InvalidArgumentError(
      `Expected one of ${EXPLORE_MODES.join(", ")}.`,
    );
  return value as ExploreMode;
}

export function seedValue(value: string): number {
  const seed = /^\d{1,10}$/u.test(value) ? Number(value) : NaN;
  if (!(seed <= 0x7fffffff))
    throw new InvalidArgumentError("Expected an integer from 0 to 2147483647.");
  return seed;
}

function watched(options: ExploreCommandOptions): {
  oracles?: OracleOptions;
} {
  const origins = options.watchOrigins ?? [];
  const ignore = options.ignoreConsole ?? [];
  const oracles: OracleOptions = {
    ...(origins.length ? { watchOrigins: origins } : {}),
    ...(options.rejectedSubmits ? { rejectedSubmits: true } : {}),
    ...(ignore.length ? { ignoreConsole: ignore } : {}),
  };
  return Object.keys(oracles).length ? { oracles } : {};
}

function tuning(options: ExploreCommandOptions): {
  tuning?: { skipDestructive?: number; strictSafety?: boolean };
} {
  if (options.allowDestructive) return { tuning: { skipDestructive: 2 } };
  return options.strictSafety ? { tuning: { strictSafety: true } } : {};
}

/** A new browser context, signed in with the stored cookies when given. */
async function openPage(
  browser: BrowserSession,
  cookies: string | undefined,
): Promise<{ page: BrowserPage; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  if (cookies) {
    const state = JSON.parse(await readFile(cookies, "utf8")) as {
      cookies?: unknown[];
    };
    const native = page.playwright?.();
    if (!native) throw new Error("Cookies need a Playwright browser.");
    await native.context.addCookies((state.cookies ?? []) as never);
  }
  return { page, close: () => context.close() };
}

/** Collect a repeatable string option. */
export function collectText(value: string, previous: readonly string[] = []) {
  return [...previous, value];
}

/** Collect `--watch-origin` values as normalized origins. */
export function watchOrigin(
  value: string,
  previous: readonly string[] = [],
): string[] {
  return [...previous, new URL(startUrl(value)).origin];
}

export function startUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // Reported below.
  }
  throw new InvalidArgumentError("Expected an absolute http or https URL.");
}

function describe(action: ExploreAction): string {
  if (action.kind === "click")
    return `click ${action.target.role} "${action.target.name}"`;
  if (action.kind === "type")
    return `type ${action.source.kind === "faker" ? action.source.generator : action.source.kind} into "${action.target.name}"`;
  return action.kind;
}

function progressLine(entry: TraceEntry): string {
  const kind = entry.pageKind ? ` [${entry.pageKind}]` : "";
  const events = entry.events.length
    ? `  ! ${entry.events.map((e) => e.signature).join("; ")}`
    : "";
  const outcome = entry.outcome === "acted" ? "" : ` (${entry.outcome})`;
  return `${String(entry.step).padStart(4)} ${entry.route}${kind}  ${describe(entry.action)}${outcome}${events}\n`;
}

function cost(calls: readonly ProviderCall[]): string {
  const tokens = calls.reduce((sum, call) => sum + call.usage.inputTokens, 0);
  const usd = calls.reduce((sum, call) => sum + (call.totalCostUsd ?? 0), 0);
  return `${calls.length} calls, ${tokens} input tokens, $${usd.toFixed(5)}`;
}

async function launch(headed: boolean): Promise<BrowserSession> {
  const { PlaywrightBrowserDriver } = await import("@sedum-dev/core");
  return new PlaywrightBrowserDriver().launch({
    browser: "chromium",
    headless: !headed,
  });
}

async function advisor(mode: ExploreMode, needed: boolean) {
  if (mode !== "guided" && !needed) return undefined;
  const { TypeSafeAdapter } = await import("@sedum-dev/provider-typesafe");
  return new TypeSafeAdapter();
}

/**
 * The trace length up to and including a step. Forced entries (a return to
 * the site, a restart) share a step number, so steps and indices differ.
 */
function traceEnd(result: ExploreResult, step: number): number {
  let end = 0;
  result.trace.forEach((entry, index) => {
    if (entry.step <= step) end = index + 1;
  });
  return end;
}

/** Shrink each failure and write it as a plain-English Sedum test. */
async function shrinkFailures(
  browser: BrowserSession,
  result: ExploreResult,
  options: ExploreCommandOptions,
  directory: string,
): Promise<ProviderCall[]> {
  const { shrink, emitTest } = await import("@sedum-dev/core");
  const resolver = (await advisor("guided", true))!;
  const actions = result.trace.map((entry) => entry.action);
  const calls: ProviderCall[] = [];
  const freshPage = () => openPage(browser, options.cookies);
  for (const [index, failure] of result.failures.entries()) {
    const prefix = actions.slice(0, traceEnd(result, failure.step));
    const shrunk = await shrink({
      startUrl: result.startUrl,
      actions: prefix,
      signature: failure.signature,
      freshPage,
      ...watched(options),
    });
    if (!shrunk.reproduced) {
      options.write(`  ${failure.signature}: did not reproduce on replay\n`);
      continue;
    }
    const fresh = await freshPage();
    try {
      const emitted = await emitTest(fresh.page, resolver, {
        startUrl: result.startUrl,
        actions: shrunk.actions,
        failure,
        originalLength: prefix.length,
        ...watched(options),
      });
      calls.push(...emitted.calls);
      const file = path.join(directory, `failure-${index + 1}.test.yaml`);
      await writeFile(file, emitted.yaml);
      const matched = emitted.steps.filter(
        (s) => s.roundTrip === "matched",
      ).length;
      const located = emitted.steps.filter((s) => s.roundTrip !== "n/a").length;
      options.write(
        `  ${failure.signature}\n    ${prefix.length} -> ${shrunk.actions.length} actions in ${shrunk.replays} replays; ${matched}/${located} sentences round-tripped; ${emitted.reproduced ? "reproduced" : "NOT reproduced"} by sentences\n    ${file}\n`,
      );
    } finally {
      await fresh.close();
    }
  }
  return calls;
}

function summary(result: ExploreResult): string {
  const kinds = Object.entries(result.kinds)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  const lines = [
    `\nExplored ${result.trace.length} actions in ${(result.elapsedMs / 1000).toFixed(1)}s (seed ${result.seed}, ${result.mode}).`,
    `States: ${result.states} distinct, ${result.routes.length} routes.${kinds ? ` Page kinds: ${kinds}.` : ""}`,
    result.skippedDestructive.length
      ? `Skipped as destructive: ${result.skippedDestructive.join(", ")}.`
      : "",
    result.calls.length ? `Jev: ${cost(result.calls)}.` : "",
    Object.keys(result.writes).length
      ? `Writes (successful non-GET requests): ${Object.entries(result.writes)
          .map(([key, n]) => `${key} ×${n}`)
          .join(", ")}.`
      : "No writes observed.",
    result.stopReason ? `Stopped early: ${result.stopReason}` : "",
    result.failures.length
      ? `Failures (${result.failures.length}):\n${result.failures.map((f: ExploreFailure) => `  step ${f.step}: ${f.signature}`).join("\n")}`
      : "No failures observed.",
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}

/** `sedum explore <url>`: a seeded, guided random walk with oracles. */
export async function executeExploreCommand(
  options: ExploreCommandOptions,
): Promise<number> {
  const { explore } = await import("@sedum-dev/core");
  const seed = options.seed ?? randomInt(0x7fffffff);
  const directory = path.resolve(
    options.out,
    `${new Date().toISOString().replaceAll(":", "-")}-seed-${seed}`,
  );
  await mkdir(directory, { recursive: true });
  const tracePath = path.join(directory, "trace.jsonl");
  const header = {
    sedumExplore: 1,
    startUrl: options.url,
    seed,
    mode: options.mode,
    steps: options.steps,
  };
  await writeFile(tracePath, `${JSON.stringify(header)}\n`);
  options.write(
    `Exploring ${options.url} (seed ${seed}, ${options.mode}). Trace: ${tracePath}\n`,
  );
  const browser = await launch(options.headed);
  try {
    const { page, close } = await openPage(browser, options.cookies);
    const lines: string[] = [];
    const guide = await advisor(options.mode, false);
    const result = await explore(page, {
      startUrl: options.url,
      steps: options.steps,
      seed,
      mode: options.mode,
      ...(guide ? { advisor: guide } : {}),
      ...tuning(options),
      ...watched(options),
      ...(options.signal ? { signal: options.signal } : {}),
      onStep: async (entry) => {
        lines.push(JSON.stringify(entry));
        options.write(progressLine(entry));
        await writeFile(tracePath, `${lines.at(-1)}\n`, { flag: "a" });
      },
    });
    await close();
    options.write(summary(result));
    // The trace is already in trace.jsonl.
    await writeFile(
      path.join(directory, "summary.json"),
      `${JSON.stringify({ ...result, trace: undefined }, null, 2)}\n`,
    );
    if (options.shrink && result.failures.length) {
      options.write("Shrinking failures:\n");
      const calls = await shrinkFailures(browser, result, options, directory);
      if (calls.length) options.write(`Locator round-trips: ${cost(calls)}.\n`);
    }
    return result.failures.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

/** `sedum explore --replay <trace.jsonl>`: re-run a recorded trace. */
export async function executeReplayCommand(
  options: ReplayCommandOptions,
): Promise<number> {
  const { replay } = await import("@sedum-dev/core");
  const [first, ...rest] = (await readFile(options.trace, "utf8"))
    .split("\n")
    .filter(Boolean);
  const header = JSON.parse(first ?? "{}") as { startUrl?: string };
  if (!header.startUrl)
    throw new InvalidArgumentError("Not an exploration trace.");
  const actions = rest.map((line) => (JSON.parse(line) as TraceEntry).action);
  const browser = await launch(options.headed);
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const result = await replay(
      await context.newPage(),
      header.startUrl,
      actions,
    );
    const signatures = [...new Set(result.events.map((e) => e.signature))];
    options.write(
      `Replayed ${result.divergedAt ?? actions.length} of ${actions.length} actions${result.divergedAt === undefined ? "" : ` (diverged at action ${result.divergedAt})`}.\n${signatures.length ? signatures.map((s) => `  ${s}`).join("\n") : "No failures observed."}\n`,
    );
    return signatures.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

export interface ExploreFlags {
  readonly steps: number;
  readonly seed?: number;
  readonly mode: ExploreMode;
  readonly out: string;
  readonly shrink: boolean;
  readonly replay?: string;
  readonly allowDestructive: boolean;
  readonly watchOrigin: readonly string[];
  readonly rejectedSubmits: boolean;
  readonly ignoreConsole: readonly string[];
  readonly strictSafety: boolean;
  readonly cookies?: string;
  readonly headed: boolean;
}

export interface ExploreIo {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly signal?: AbortSignal;
}

function run(url: string, flags: ExploreFlags, io: ExploreIo): Promise<number> {
  return executeExploreCommand({
    url,
    steps: flags.steps,
    ...(flags.seed === undefined ? {} : { seed: flags.seed }),
    mode: flags.mode,
    out: path.resolve(io.cwd, flags.out),
    shrink: flags.shrink,
    headed: flags.headed,
    allowDestructive: flags.allowDestructive,
    watchOrigins: flags.watchOrigin,
    rejectedSubmits: flags.rejectedSubmits,
    ignoreConsole: flags.ignoreConsole,
    strictSafety: flags.strictSafety,
    ...(flags.cookies ? { cookies: path.resolve(io.cwd, flags.cookies) } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    write: io.write,
  });
}

/** The `sedum explore` action: replay a trace, or explore from a URL. */
export async function exploreAction(
  url: string | undefined,
  flags: ExploreFlags,
  io: ExploreIo,
): Promise<number> {
  const { ProviderError } = await import("@sedum-dev/core");
  try {
    if (flags.replay)
      return await executeReplayCommand({
        trace: path.resolve(io.cwd, flags.replay),
        headed: flags.headed,
        write: io.write,
      });
    if (url) return await run(url, flags, io);
    io.writeErr("Missing start URL.\nFix: use `sedum explore <url>`.\n");
  } catch (error) {
    if (!(error instanceof ProviderError && error.code === "configuration"))
      throw error;
    io.writeErr(
      `${error.message}\nFix: set TYPESAFE_API_KEY, or use --mode random or --mode heuristic without --shrink.\n`,
    );
  }
  return 3;
}
