import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { ExploreDetect, ExploreSafeMode } from "./cli-arguments.js";
import {
  loadProjectConfig,
  ProjectConfigError,
  readProjectEnvironment,
} from "./config.js";
import { configDiagnostic } from "./diagnostics.js";
import { FrameRecorder } from "./explore-frames.js";
import { writeExploreReports } from "./explore-output.js";
import type {
  BrowserPage,
  BrowserSession,
  ExploreAction,
  ExploreFailure,
  ExploreMode,
  ExplorePlanner,
  ExploreResult,
  ExploreSafety,
  FindingTest,
  OracleOptions,
  ProviderCall,
  TraceEntry,
} from "@sedum-dev/core";

export interface ExploreCommandOptions {
  readonly url: string;
  readonly steps: number;
  readonly seed?: number;
  readonly mode: ExploreMode;
  /** "walk" by default; "effects" plans over Jev's labels (guided only). */
  readonly planner?: ExplorePlanner;
  readonly out: string;
  readonly shrink: boolean;
  readonly headed: boolean;
  /** "off" by default: only session-ending targets are skipped. */
  readonly safety: ExploreSafety;
  /** Capture a frame per step and embed them in report.html. */
  readonly replay?: boolean;
  /** Origins whose pages get no frames. */
  readonly sensitiveOrigins?: readonly string[];
  /** More origins whose HTTP 5xx responses count, such as an API host. */
  readonly watchOrigins?: readonly string[];
  /** Report 4xx answers to submissions (see OracleOptions). */
  readonly rejectedSubmits?: boolean;
  /** Console errors matching these regular expressions are ignored. */
  readonly ignoreConsole?: readonly string[];
  /** "semantic" adds the bug detector's page checks to each Jev call. */
  readonly detect?: ExploreDetect;
  /** Known findings to ignore, as `--detect-allow` rules. */
  readonly detectAllow?: readonly string[];
  /** A Playwright storage-state file whose cookies sign the browser in. */
  readonly cookies?: string;
  /** Jev's TypeSafe settings; unset values come from the process environment. */
  readonly provider?: ExploreProvider;
  readonly signal?: AbortSignal;
  readonly write: (text: string) => void;
}

export interface RerunCommandOptions {
  readonly trace: string;
  readonly headed: boolean;
  readonly write: (text: string) => void;
}

export const EXPLORE_MODES: readonly ExploreMode[] = [
  "guided",
  "heuristic",
  "random",
];

/** A parser that accepts one of a closed set of names. */
function oneOf<T extends string>(names: readonly T[]): (value: string) => T {
  return (value) => {
    if (!names.includes(value as T))
      throw new InvalidArgumentError(`Expected one of ${names.join(", ")}.`);
    return value as T;
  };
}

export const exploreMode = oneOf(EXPLORE_MODES);

export const EXPLORE_PLANNERS: readonly ExplorePlanner[] = ["walk", "effects"];

export const explorePlanner = oneOf(EXPLORE_PLANNERS);

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
  const allow = options.detectAllow ?? [];
  const oracles: OracleOptions = {
    ...(origins.length ? { watchOrigins: origins } : {}),
    ...(options.rejectedSubmits ? { rejectedSubmits: true } : {}),
    ...(ignore.length ? { ignoreConsole: ignore } : {}),
    ...(allow.length ? { allow } : {}),
  };
  return Object.keys(oracles).length ? { oracles } : {};
}

function tuning(options: ExploreCommandOptions): {
  tuning: { safety: ExploreSafety };
} {
  return { tuning: { safety: options.safety } };
}

/** A Playwright storage-state file: cookies, and local storage per origin. */
interface StorageState {
  readonly cookies?: unknown[];
  readonly origins?: readonly {
    readonly origin: string;
    readonly localStorage: readonly { name: string; value: string }[];
  }[];
}

/** A page script, run before the page's own: restore one origin's items. */
function restoreLocalStorage(
  origin: string,
  items: readonly { name: string; value: string }[],
): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(origin)}) return;
  for (const { name, value } of ${JSON.stringify(items)})
    if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
})()`;
}

/** A new browser context, signed in with a stored state when given. */
async function openPage(
  browser: BrowserSession,
  cookies: string | undefined,
): Promise<{ page: BrowserPage; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  if (cookies) {
    const state = JSON.parse(await readFile(cookies, "utf8")) as StorageState;
    const native = page.playwright?.();
    if (!native) throw new Error("Cookies need a Playwright browser.");
    await native.context.addCookies((state.cookies ?? []) as never);
    // Apps that keep their sign-in token in local storage (a JWT) need it too.
    for (const { origin, localStorage } of state.origins ?? [])
      await native.context.addInitScript(
        restoreLocalStorage(origin, localStorage),
      );
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

async function advisor(
  mode: ExploreMode,
  needed: boolean,
  provider: ExploreProvider = {},
) {
  if (mode !== "guided" && !needed) return undefined;
  const { TypeSafeAdapter } = await import("@sedum-dev/provider-typesafe");
  return new TypeSafeAdapter(provider);
}

/** The TypeSafe settings the walk's Jev calls use. */
export interface ExploreProvider {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
}

/** The walk's TypeSafe settings, and the variable its key is read from. */
export interface ExploreCredentials {
  readonly provider: ExploreProvider;
  readonly keyName: string;
}

/**
 * The TypeSafe key, TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL as `sedum run`
 * reads them: the process environment first, then the project-root `.env`.
 * The key comes from `provider.apiKeyEnv` in sedum.config.yaml when the
 * project uses TypeSafe, else from TYPESAFE_API_KEY.
 */
export async function exploreProvider(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ExploreCredentials> {
  const config = await loadProjectConfig(cwd, environment);
  const file = await readProjectEnvironment(config.projectRoot);
  const value = (name: string): string | undefined =>
    environment[name]?.trim() || file[name]?.trim() || undefined;
  const keyName =
    config.providerName === "typesafe"
      ? (config.apiKeyEnv ?? "TYPESAFE_API_KEY")
      : "TYPESAFE_API_KEY";
  // Always set, even when empty: the adapter would otherwise fall back to
  // TYPESAFE_API_KEY, which a configured `provider.apiKeyEnv` replaces.
  const apiKey = value(keyName) ?? "";
  const baseURL = value("TYPESAFE_BASE_URL");
  const model = value("TYPESAFE_DEFAULT_MODEL");
  return {
    provider: {
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
    },
    keyName,
  };
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

interface Shrunk {
  readonly calls: ProviderCall[];
  readonly tests: Map<string, FindingTest>;
}

/** Shrink each failure and write it as a plain-English Sedum test. */
/** What shrinking one finding needs. */
interface ShrinkContext {
  readonly result: ExploreResult;
  readonly options: ExploreCommandOptions;
  readonly directory: string;
  readonly resolver: Awaited<ReturnType<typeof advisor>> & object;
  readonly freshPage: () => ReturnType<typeof openPage>;
  readonly calls: ProviderCall[];
}

async function shrinkFailures(
  browser: BrowserSession,
  result: ExploreResult,
  options: ExploreCommandOptions,
  directory: string,
): Promise<Shrunk> {
  const context: ShrinkContext = {
    result,
    options,
    directory,
    resolver: (await advisor("guided", true, options.provider))!,
    freshPage: () => openPage(browser, options.cookies),
    calls: [],
  };
  const tests = new Map<string, FindingTest>();
  await mkdir(path.join(directory, "tests"), { recursive: true });
  for (const [index, failure] of result.failures.entries())
    tests.set(failure.signature, await shrinkOne(failure, index, context));
  return { calls: context.calls, tests };
}

/** Shrink one finding and write its test, or say why there is none. */
async function shrinkOne(
  failure: ExploreFailure,
  index: number,
  context: ShrinkContext,
): Promise<FindingTest> {
  const { result, options } = context;
  // A page check needs Jev on every replay; it is reported, not shrunk.
  if (failure.kind === "semantic") {
    options.write(`  ${failure.signature}: page check, not shrunk\n`);
    return { notShrunk: "a page check needs Jev on every replay" };
  }
  const { shrink } = await import("@sedum-dev/core");
  const actions = result.trace.map((entry) => entry.action);
  const prefix = actions.slice(0, traceEnd(result, failure.step));
  const shrunk = await shrink({
    startUrl: result.startUrl,
    actions: prefix,
    signature: failure.signature,
    freshPage: context.freshPage,
    ...watched(options),
  });
  if (!shrunk.reproduced) {
    options.write(`  ${failure.signature}: did not reproduce on replay\n`);
    return { notShrunk: "did not reproduce on replay" };
  }
  const test = await emitOne(
    { failure, index, actions: shrunk.actions, originalLength: prefix.length },
    context,
  );
  options.write(
    `  ${failure.signature}\n    ${prefix.length} -> ${shrunk.actions.length} actions in ${shrunk.replays} replays; ${test.sentences.matched}/${test.sentences.located} sentences round-tripped; ${test.reproduced ? "reproduced" : "NOT reproduced"} by sentences\n    ${path.join(context.directory, test.path)}\n`,
  );
  return test;
}

/** Emit the shrunk actions as sentences, checked through the locator. */
async function emitOne(
  shrunk: {
    readonly failure: ExploreFailure;
    readonly index: number;
    readonly actions: readonly ExploreAction[];
    readonly originalLength: number;
  },
  context: ShrinkContext,
): Promise<Extract<FindingTest, { path: string }>> {
  const { failure, index, actions, originalLength } = shrunk;
  const { emitTest } = await import("@sedum-dev/core");
  const fresh = await context.freshPage();
  try {
    const emitted = await emitTest(fresh.page, context.resolver, {
      startUrl: context.result.startUrl,
      actions,
      failure,
      originalLength,
      ...watched(context.options),
    });
    context.calls.push(...emitted.calls);
    const relative = `tests/finding-F${index + 1}.test.yaml`;
    await writeFile(path.join(context.directory, relative), emitted.yaml);
    const located = emitted.steps.filter((s) => s.roundTrip !== "n/a");
    return {
      path: relative,
      yaml: emitted.yaml,
      actionsBefore: originalLength,
      actionsAfter: actions.length,
      reproduced: emitted.reproduced,
      sentences: {
        matched: located.filter((s) => s.roundTrip === "matched").length,
        located: located.length,
      },
    };
  } finally {
    await fresh.close();
  }
}

function summary(result: ExploreResult): string {
  const kinds = Object.entries(result.kinds)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  const lines = [
    `\nExplored ${result.trace.length} actions in ${(result.elapsedMs / 1000).toFixed(1)}s (seed ${result.seed}, ${result.mode}${result.planner === "effects" ? ", effects planner" : ""}).`,
    result.effects
      ? `Effects map: ${result.effects.states} states, deepest at ${result.effects.maxDepth} forward steps.`
      : "",
    `States: ${result.states} distinct, ${result.routes.length} routes.${kinds ? ` Page kinds: ${kinds}.` : ""}`,
    result.skippedDestructive.length
      ? `Not clicked (destructive or session-ending): ${result.skippedDestructive.join(", ")}.`
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

const SAFETY_OFF =
  "Safety is off: the walk may delete, send or pay, but never logs itself out.\nUse --safe on shared or production-like data.\n";

/** A path relative to where the command ran, or absolute outside it. */
function shownPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return !relative || relative.startsWith("..") ? file : relative;
}

/** A run directory name: when it started, and the seed that repeats it. */
function runId(seed: number): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-seed-${seed}`;
}

/** Where one exploration writes, and when it started. */
interface RunPlace {
  readonly seed: number;
  readonly id: string;
  readonly directory: string;
  readonly trace: string;
  readonly startedAt: string;
}

/** Create the run directory and the trace's header line. */
async function openRun(options: ExploreCommandOptions): Promise<RunPlace> {
  const seed = options.seed ?? randomInt(0x7fffffff);
  const id = runId(seed);
  const directory = path.resolve(options.out, id);
  await mkdir(directory, { recursive: true });
  const trace = path.join(directory, "trace.jsonl");
  const header = {
    sedumExplore: 1,
    startUrl: options.url,
    seed,
    mode: options.mode,
    ...(options.planner === "effects" ? { planner: options.planner } : {}),
    steps: options.steps,
  };
  await writeFile(trace, `${JSON.stringify(header)}\n`);
  options.write(
    `Exploring ${options.url} (seed ${seed}, ${options.mode}). Trace: ${trace}\n`,
  );
  if (options.safety === "off") options.write(SAFETY_OFF);
  return { seed, id, directory, trace, startedAt: new Date().toISOString() };
}

/** The walk itself: each step goes to the trace, the terminal and frames. */
async function walk(
  page: BrowserPage,
  place: RunPlace,
  frames: FrameRecorder | null,
  options: ExploreCommandOptions,
): Promise<ExploreResult> {
  const { explore } = await import("@sedum-dev/core");
  const guide = await advisor(options.mode, false, options.provider);
  return explore(page, {
    startUrl: options.url,
    steps: options.steps,
    seed: place.seed,
    mode: options.mode,
    ...(options.planner ? { planner: options.planner } : {}),
    ...(guide ? { advisor: guide } : {}),
    ...tuning(options),
    ...watched(options),
    ...(options.detect ? { detect: options.detect } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(frames
      ? {
          beforeAction: (step, _action, box) =>
            frames.before(step, box ?? null),
        }
      : {}),
    onStep: async (entry) => {
      await frames?.after(entry.step);
      options.write(progressLine(entry));
      await writeFile(place.trace, `${JSON.stringify(entry)}\n`, { flag: "a" });
    },
  });
}

/** Shrink if asked, then write result.json, report.md and report.html. */
async function report(
  run: {
    readonly browser: BrowserSession;
    readonly result: ExploreResult;
    readonly place: RunPlace;
    readonly frames: FrameRecorder | null;
  },
  options: ExploreCommandOptions,
): Promise<void> {
  const { browser, result, place, frames } = run;
  const shrunk =
    options.shrink && result.failures.length
      ? await shrinkReport(browser, result, options, place.directory)
      : null;
  const { files } = await writeExploreReports(
    place.directory,
    result,
    {
      runId: place.id,
      startedAt: place.startedAt,
      requestedSteps: options.steps,
      safety: options.safety,
      detect: options.detect ?? "browser",
      trace: "trace.jsonl",
      directory: shownPath(place.directory),
      ...(frames ? { frames: frames.frames } : {}),
      ...(shrunk ? { tests: shrunk.tests, extraCalls: shrunk.calls } : {}),
    },
    frames?.bytes ?? new Map(),
  );
  options.write(
    `result ${files.result}\nmarkdown ${files.markdown}\nreport ${files.html}\n`,
  );
}

/** `sedum explore <url>`: a seeded, guided random walk with oracles. */
export async function executeExploreCommand(
  options: ExploreCommandOptions,
): Promise<number> {
  const place = await openRun(options);
  const browser = await launch(options.headed);
  try {
    const { page, close } = await openPage(browser, options.cookies);
    const frames = options.replay
      ? await FrameRecorder.create(
          place.directory,
          page,
          options.sensitiveOrigins ?? [],
        )
      : null;
    const result = await walk(page, place, frames, options);
    await close();
    options.write(summary(result));
    await report({ browser, result, place, frames }, options);
    return result.failures.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

async function shrinkReport(
  browser: BrowserSession,
  result: ExploreResult,
  options: ExploreCommandOptions,
  directory: string,
): Promise<Shrunk> {
  options.write("Shrinking failures:\n");
  const shrunk = await shrinkFailures(browser, result, options, directory);
  if (shrunk.calls.length)
    options.write(`Locator round-trips: ${cost(shrunk.calls)}.\n`);
  return shrunk;
}

/** `sedum explore --rerun <trace.jsonl>`: run a recorded trace again. */
export async function executeRerunCommand(
  options: RerunCommandOptions,
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
      `Reran ${result.divergedAt ?? actions.length} of ${actions.length} actions${result.divergedAt === undefined ? "" : ` (diverged at action ${result.divergedAt})`}.\n${signatures.length ? signatures.map((s) => `  ${s}`).join("\n") : "No failures observed."}\n`,
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
  readonly planner?: ExplorePlanner;
  readonly out: string;
  readonly shrink: boolean;
  /** A trace.jsonl to run again instead of exploring. */
  readonly rerun?: string;
  /** Capture frames (like `sedum run --replay`). */
  readonly replay: boolean;
  /** `--safe` alone is true; `--safe strict` names the mode. */
  readonly safe?: true | ExploreSafeMode;
  readonly sensitiveOrigin: readonly string[];
  readonly watchOrigin: readonly string[];
  readonly rejectedSubmits: boolean;
  readonly ignoreConsole: readonly string[];
  readonly detect: ExploreDetect;
  readonly detectAllow: readonly string[];
  readonly cookies?: string;
  readonly headed: boolean;
}

export interface ExploreIo {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** Off unless asked: `--safe` is "on", `--safe strict` is "strict". */
function safetyOf(safe: ExploreFlags["safe"]): ExploreSafety {
  if (safe === undefined) return "off";
  return safe === true ? "on" : safe;
}

async function run(
  url: string,
  flags: ExploreFlags,
  io: ExploreIo,
  provider: ExploreProvider,
): Promise<number> {
  return executeExploreCommand({
    url,
    steps: flags.steps,
    ...(flags.seed === undefined ? {} : { seed: flags.seed }),
    mode: flags.mode,
    ...(flags.planner ? { planner: flags.planner } : {}),
    out: path.resolve(io.cwd, flags.out),
    shrink: flags.shrink,
    headed: flags.headed,
    safety: safetyOf(flags.safe),
    replay: flags.replay,
    sensitiveOrigins: flags.sensitiveOrigin,
    watchOrigins: flags.watchOrigin,
    rejectedSubmits: flags.rejectedSubmits,
    ignoreConsole: flags.ignoreConsole,
    detect: flags.detect,
    detectAllow: flags.detectAllow,
    ...(flags.cookies ? { cookies: path.resolve(io.cwd, flags.cookies) } : {}),
    provider,
    ...(io.signal ? { signal: io.signal } : {}),
    write: io.write,
  });
}

/** What is wrong with an exploration's arguments, or null. */
function usageProblem({
  url,
  flags,
}: {
  readonly url?: string | undefined;
  readonly flags: ExploreFlags;
}): string | null {
  if (flags.planner === "effects" && flags.mode !== "guided")
    return "--planner effects asks Jev what each control does.\nFix: use it with --mode guided.\n";
  if (flags.detect === "semantic" && flags.mode !== "guided")
    return "--detect semantic asks Jev in each new page's guided call.\nFix: use it with --mode guided.\n";
  return url ? null : "Missing start URL.\nFix: use `sedum explore <url>`.\n";
}

/** The `sedum explore` action: replay a trace, or explore from a URL. */
export async function exploreAction(
  url: string | undefined,
  flags: ExploreFlags,
  io: ExploreIo,
): Promise<number> {
  if (flags.rerun)
    return executeRerunCommand({
      trace: path.resolve(io.cwd, flags.rerun),
      headed: flags.headed,
      write: io.write,
    });
  const problem = usageProblem({ url, flags });
  if (problem) {
    io.writeErr(problem);
    return 3;
  }
  return explore(url!, flags, io);
}

/** Explore from a URL with the project's TypeSafe credentials. */
async function explore(
  url: string,
  flags: ExploreFlags,
  io: ExploreIo,
): Promise<number> {
  const credentials = await projectCredentials(io);
  if (!credentials) return 3;
  const { ProviderError } = await import("@sedum-dev/core");
  try {
    return await run(url, flags, io, credentials.provider);
  } catch (error) {
    if (!(error instanceof ProviderError && error.code === "configuration"))
      throw error;
    io.writeErr(missingKeyMessage(credentials, error.message));
  }
  return 3;
}

/** The project's TypeSafe credentials, or null after reporting a bad config. */
async function projectCredentials(
  io: ExploreIo,
): Promise<ExploreCredentials | null> {
  try {
    return await exploreProvider(io.cwd);
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    const diagnostic = configDiagnostic(error);
    io.writeErr(`${diagnostic.message}\nFix: ${diagnostic.fix}\n`);
    return null;
  }
}

/** The adapter's configuration error, naming the variable the key comes from. */
function missingKeyMessage(
  { provider, keyName }: ExploreCredentials,
  adapterMessage: string,
): string {
  const message = provider.apiKey
    ? adapterMessage
    : `Set ${keyName} to use the TypeSafe provider.`;
  return `${message}\nFix: set ${keyName} in the project-root .env or your shell, or use --mode random or --mode heuristic without --shrink.\n`;
}
