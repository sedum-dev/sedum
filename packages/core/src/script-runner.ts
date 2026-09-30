import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BrowserDriverError,
  type BrowserPage,
  type BrowserSession,
} from "./browser-driver.js";
import {
  classifySentenceSteps,
  type ClassifiedFlowSentence,
} from "./flow-classification.js";
import {
  closeQuietly,
  executeSentence,
  firstDiagnostic,
  resolveEntryUrl,
  resultCall,
  runtimeFailure,
  type AttemptDependencies,
  type FlowRunResult,
  type FlowRunnerDependencies,
  type SentencePresentation,
} from "./flow-runner.js";
import type { FlowSource, SentenceStep } from "./flow-types.js";
import {
  tokenizeStep,
  validateTypeOperand,
  type ResolvedDataEntry,
} from "./flow-values.js";
import { ProviderError } from "./provider.js";
import { safeSource, safeText } from "./report-privacy.js";
import type { ResultStep } from "./run-result.js";
import { loadScriptFile, type ScriptTest } from "./script-loader.js";
import {
  isSecret,
  revealSecret,
  sourceInFile,
  type Ai,
  type AiValues,
  type Parser,
  type TestContext,
} from "./script-registry.js";
import { scanScriptSentences } from "./script-sentences.js";
import { RuntimeUrl, RuntimeValue, executeStep } from "./step-executor.js";

type Problem = Exclude<FlowRunResult, { status: "passed" }>;

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXTRACT_KEY = "sedum_extracted";
const REMEMBER_AS =
  /^(?:remember|capture)\b.*\bas\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*\.?$/iu;
const STEP_ERROR = Symbol.for("sedum.script.stepError");
/** The group path where an exception from test code was thrown. */
const THROWN_IN = Symbol("sedum.script.thrownIn");

/** A misuse of the `ai` API: the test cannot run as written. */
export class ScriptUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = "ScriptUsageError";
  }
}

/** Thrown from `ai()` after a step fails, to stop the test body. */
class StepStop extends Error {
  readonly [STEP_ERROR] = true;
  constructor(readonly problem: Problem) {
    super(
      problem.status === "failed"
        ? "A Sedum step failed; see the run report."
        : `A Sedum step could not run: ${problem.message}`,
    );
    this.name = "SedumStepError";
  }
}

function isStepStop(error: unknown): error is StepStop {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[STEP_ERROR] === true
  );
}

/** Convert `{{name}}` values to the runner's opaque data entries. */
export function valueEntries(
  values: AiValues | undefined,
): Record<string, ResolvedDataEntry> {
  const entries: Record<string, ResolvedDataEntry> = Object.create(
    null,
  ) as Record<string, ResolvedDataEntry>;
  if (values === undefined) return entries;
  if (typeof values !== "object" || values === null || Array.isArray(values))
    throw new ScriptUsageError(
      "invalid_values",
      "The values argument must be an object of {{name}} values.",
      'Pass values as an object: ai("type {{email}} into the Email field", { email }).',
    );
  for (const [key, value] of Object.entries(values)) {
    if (!KEY.test(key))
      throw new ScriptUsageError(
        "invalid_value_name",
        `\`${key}\` is not a valid placeholder name.`,
        "Use letters, digits, and underscores, starting with a letter or underscore.",
      );
    const display = `{{${key}}}`;
    if (isSecret(value)) {
      const text = revealSecret(value);
      entries[key] = {
        value: new RuntimeValue(text, display),
        sensitive: true,
        modelVisible: false,
        opaqueValues: [new RuntimeValue(text, display)],
      };
    } else if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      entries[key] = {
        value: new RuntimeValue(String(value), display),
        sensitive: false,
        modelVisible: true,
      };
    else
      throw new ScriptUsageError(
        "invalid_value",
        `The value for {{${key}}} must be a string, a finite number, a boolean, or secret().`,
        "Convert it with String(...) or wrap sensitive text in secret().",
      );
  }
  return entries;
}

/**
 * Inline plain values into the sentence the locator and Judge read, so
 * `click Add to cart for {{product}}` names the product. A `type` value and
 * secrets stay placeholders, as does a value that would change the sentence's
 * own quotes or placeholders.
 */
export function inlineValues(
  step: SentenceStep,
  op: string,
  values: Readonly<Record<string, ResolvedDataEntry>>,
): string {
  const operand = op === "type" ? validateTypeOperand(step) : null;
  const span =
    operand && "operand" in operand ? operand.operand : { start: -1, end: -1 };
  let text = step.text;
  for (const token of [...step.tokens].reverse()) {
    if (token.kind !== "placeholder") continue;
    if (token.start >= span.start && token.end <= span.end) continue;
    const entry = values[token.key!];
    if (!entry || entry.sensitive) continue;
    const value = entry.value.reveal();
    if (/["\n]|\{\{|\}\}/u.test(value)) continue;
    text = text.slice(0, token.start) + value + text.slice(token.end);
  }
  return text;
}

function sentenceStep(text: string, source: FlowSource): SentenceStep {
  return {
    kind: "sentence",
    phase: "steps",
    text,
    tokens: tokenizeStep(text).tokens,
    source,
    sourceStack: [source],
  };
}

/** Run one `test()` from a `*.test.ts` file as one attempt. */
export async function runScriptTest(
  file: string,
  identity: string | undefined,
  runDependencies: FlowRunnerDependencies,
): Promise<FlowRunResult> {
  const absolute = path.resolve(file);
  const script = await loadScriptFile(absolute, {
    repoRoot: runDependencies.repoRoot,
  });
  const test: ScriptTest | undefined =
    identity === undefined
      ? script.tests.length === 1
        ? script.tests[0]
        : undefined
      : script.tests.find((candidate) => candidate.identity === identity);
  if (!test) {
    if (script.diagnostics.length) return firstDiagnostic(script.diagnostics);
    return {
      status: "could_not_run",
      file: absolute,
      code: "test_not_found",
      message:
        identity === undefined
          ? "This file declares several tests; one must be selected."
          : `No test with id ${JSON.stringify(identity)} is declared in this file.`,
      fix: "Run `sedum list` to see the test ids in this file.",
    };
  }
  let entryUrl: string | undefined;
  if (test.url !== undefined || runDependencies.baseUrl) {
    try {
      entryUrl = resolveEntryUrl(
        test.url,
        runDependencies.baseUrl,
        runDependencies.urlOverride,
      );
    } catch (error) {
      return {
        status: "could_not_run",
        file: absolute,
        code: "invalid_test",
        source: test.source,
        message:
          error instanceof Error
            ? error.message
            : "The test entry URL could not be resolved.",
        fix: "Use an absolute test url or configure baseUrl in sedum.config.yaml.",
      };
    }
  }

  let dependencies: AttemptDependencies;
  const { report: runReport, ...runBase } = runDependencies;
  if (runReport) {
    const { recorder, slot, ...shared } = runReport;
    const privacy = {
      ...shared.privacy,
      secretValues: [...shared.privacy.secretValues],
    };
    const shownFile = safeSource(
      { file: absolute, line: 1, col: 1 },
      runDependencies.repoRoot,
      privacy,
    ).file;
    const existing = slot
      ? recorder.testAt(slot.ordinal)
      : recorder.latestTest();
    const retrying =
      existing?.file === shownFile &&
      existing.test.id === test.identity &&
      existing.currentAttempt?.running === true;
    const recording = retrying
      ? existing
      : await recorder.beginTest({
          id: test.identity,
          file: shownFile,
          description: safeText(test.title, privacy, 512),
          tags: test.tags.map((tag) => safeText(tag, privacy, 120)),
          ...(slot ? { ordinal: slot.ordinal } : {}),
          ...(slot?.lane === undefined ? {} : { lane: slot.lane }),
        });
    dependencies = {
      ...runBase,
      report: { ...shared, privacy, test: recording },
    };
  } else dependencies = runBase;
  const report = dependencies.report;
  const classifyOptions = {
    mode: "allow-model" as const,
    cache: dependencies.classificationCache,
    provider: dependencies.provider,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  };

  // Classify every literal sentence in the file in one batch before the
  // browser starts, as a YAML test does. Problems surface at the step itself.
  try {
    const scan = scanScriptSentences(
      await readFile(absolute, "utf8"),
      absolute,
    );
    if (scan.sentences.length) {
      const warm = await classifySentenceSteps(
        scan.sentences.map((item) => sentenceStep(item.text, item.source)),
        classifyOptions,
      );
      if (report && warm.classification.calls.length)
        await report.test.addAttemptCalls(
          warm.classification.calls.map((call) =>
            resultCall(call, "classification"),
          ),
        );
    }
  } catch {
    // Each step classifies itself again when it runs.
  }

  const bindings: Record<string, ResolvedDataEntry> = Object.create(
    null,
  ) as Record<string, ResolvedDataEntry>;
  const opaqueEntries: ResolvedDataEntry[] = [];
  let firstProblem: Problem | null = null;
  let inFlight: Promise<unknown> | null = null;
  let finished = false;
  const groups: string[] = [];

  let session: BrowserSession | undefined;
  let context: Awaited<ReturnType<BrowserSession["newContext"]>> | undefined;
  let page: BrowserPage | undefined;
  try {
    session = await dependencies.browser.launch({
      ...(dependencies.browserKind === undefined
        ? {}
        : { browser: dependencies.browserKind }),
      ...(dependencies.headless === undefined
        ? {}
        : { headless: dependencies.headless }),
      ...(dependencies.slowMoMs === undefined
        ? {}
        : { slowMoMs: dependencies.slowMoMs }),
      ...(dependencies.headedOverlay ? { overlay: true } : {}),
    });
    context = await session.newContext(
      dependencies.viewport === undefined
        ? {}
        : { viewport: dependencies.viewport },
    );
    page = await context.newPage();
    const activePage = page;
    if (entryUrl !== undefined)
      await executeStep(
        activePage,
        { op: "goto", url: new RuntimeUrl([entryUrl]) },
        dependencies.signal ? { signal: dependencies.signal } : {},
      );

    const where = (stack: string | undefined): FlowSource =>
      sourceInFile(stack, absolute) ?? test.source;

    const stop = (problem: Problem): never => {
      firstProblem ??= problem;
      throw new StepStop(problem);
    };

    // Reported like an invalid YAML test: the file and line, then the fix.
    const usage = (error: ScriptUsageError, source: FlowSource): never =>
      stop({
        status: "could_not_run",
        file: absolute,
        code: "invalid_test",
        source,
        message: error.message,
        fix: error.fix,
      });

    /** Serialize steps and catch a missing `await` before it races the page. */
    const exclusive = async <T>(
      source: FlowSource,
      work: () => Promise<T>,
    ): Promise<T> => {
      if (finished)
        usage(
          new ScriptUsageError(
            "step_after_test",
            "An ai step ran after the test body had finished.",
            "Await every ai(...) call inside the test body.",
          ),
          source,
        );
      if (inFlight)
        usage(
          new ScriptUsageError(
            "step_not_awaited",
            "An ai step started while the previous one was still running.",
            "Add `await` before each ai(...) call.",
          ),
          source,
        );
      if (dependencies.signal?.aborted)
        stop({
          status: "could_not_run",
          file: absolute,
          code: "canceled",
          source,
          message: "The run was interrupted.",
        });
      const running = work();
      inFlight = running;
      try {
        return await running;
      } finally {
        inFlight = null;
      }
    };

    const runStep = async (
      step: ClassifiedFlowSentence,
      scope: Record<string, ResolvedDataEntry>,
      presentation: SentencePresentation,
    ): Promise<void> => {
      const outcome = await executeSentence(
        activePage,
        step,
        dependencies,
        scope,
        opaqueEntries,
        presentation,
      );
      if (outcome === "continue") return;
      if (outcome === "failed")
        stop({ status: "failed", file: absolute, source: step.source });
      else if (outcome.status !== "passed") stop(outcome);
    };

    const sentence = async (
      text: unknown,
      values: AiValues | undefined,
      source: FlowSource,
    ): Promise<void> => {
      try {
        if (typeof text !== "string" || !text.trim())
          throw new ScriptUsageError(
            "invalid_sentence",
            "An ai step must be a nonblank sentence.",
            'Write one action or claim, such as ai("click the Login button").',
          );
        const own = valueEntries(values);
        const tokenized = tokenizeStep(text);
        const problem = tokenized.problems[0];
        if (problem)
          throw new ScriptUsageError(
            problem.code,
            problem.message,
            problem.fix,
          );
        // `remember ... as {{name}}` names a new binding, not a value to pass.
        const binds = REMEMBER_AS.exec(text.trim())?.[1];
        for (const token of tokenized.tokens)
          if (
            token.kind === "placeholder" &&
            token.key !== binds &&
            !(token.key! in own) &&
            !(token.key! in bindings)
          )
            throw new ScriptUsageError(
              "missing_value",
              `{{${token.key}}} has no value.`,
              `Pass it as the second argument: ai(${JSON.stringify(text)}, { ${token.key}: ... }).`,
            );
        const template = sentenceStep(text, source);
        const checked = await classifySentenceSteps(
          [template],
          classifyOptions,
        );
        if (report && checked.classification.calls.length)
          await report.test.addAttemptCalls(
            checked.classification.calls.map((call) =>
              resultCall(call, "classification"),
            ),
          );
        const classified = checked.classification.steps[0];
        if (checked.diagnostics.length || !classified) {
          const diagnostic = checked.diagnostics[0];
          stop({
            status: "could_not_run",
            file: absolute,
            code: "invalid_test",
            source,
            message:
              diagnostic?.message ?? "This step could not be classified.",
            fix: diagnostic?.fix ?? "Rewrite it as one action or one claim.",
          });
        }
        const secrets = Object.values(own).filter((entry) => entry.sensitive);
        opaqueEntries.push(...secrets);
        report?.privacy.secretValues.push(
          ...secrets.map((entry) => entry.value.reveal()),
        );
        const scope: Record<string, ResolvedDataEntry> = Object.assign(
          Object.create(null) as Record<string, ResolvedDataEntry>,
          bindings,
          own,
        );
        const shown = sentenceStep(
          inlineValues(template, classified!.op, own),
          source,
        );
        await runStep(
          {
            ...shown,
            op: classified!.op,
            classificationSource: classified!.classificationSource,
            probability: classified!.probability,
          },
          scope,
          { group: [...groups] },
        );
        // `remember ... as {{name}}` makes a binding for later steps.
        for (const [key, entry] of Object.entries(scope))
          if (!(key in own) && !(key in bindings)) bindings[key] = entry;
      } catch (error) {
        if (error instanceof ScriptUsageError) usage(error, source);
        throw error;
      }
    };

    const sentences = async (
      input: unknown,
      values: AiValues | undefined,
      source: FlowSource,
    ): Promise<void> => {
      if (Array.isArray(input)) {
        if (!input.length)
          usage(
            new ScriptUsageError(
              "empty_steps",
              "An ai step list is empty.",
              "Pass at least one sentence.",
            ),
            source,
          );
        for (const item of input)
          await exclusive(source, () => sentence(item, values, source));
      } else await exclusive(source, () => sentence(input, values, source));
    };

    const ai = ((input: string | readonly string[], values?: AiValues) =>
      sentences(input, values, where(new Error().stack))) as Ai;

    ai.group = (async (
      name: string,
      body: unknown,
      values?: AiValues,
    ): Promise<unknown> => {
      const source = where(new Error().stack);
      if (typeof name !== "string" || !name.trim() || name.length > 120)
        usage(
          new ScriptUsageError(
            "invalid_group",
            "A group name must be a nonblank string of at most 120 characters.",
            'Write ai.group("Checkout", async () => { ... }).',
          ),
          source,
        );
      if (typeof body !== "function" && !Array.isArray(body))
        usage(
          new ScriptUsageError(
            "invalid_group",
            "A group needs a list of sentences or an async function.",
            'Write ai.group("Log in", ["click the Login button"]).',
          ),
          source,
        );
      groups.push(name);
      try {
        return typeof body === "function"
          ? await (body as () => unknown)()
          : await sentences(body, values, source);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          !(THROWN_IN in error)
        )
          Object.defineProperty(error, THROWN_IN, { value: [...groups] });
        throw error;
      } finally {
        groups.pop();
      }
    }) as Ai["group"];

    ai.extract = (async (
      description: string,
      parser?: Parser<unknown>,
    ): Promise<unknown> => {
      const source = where(new Error().stack);
      if (
        typeof description !== "string" ||
        !description.trim() ||
        /[\n{}]/u.test(description)
      )
        usage(
          new ScriptUsageError(
            "invalid_extract",
            "ai.extract takes a one-line description without placeholders.",
            'Write ai.extract("the order total").',
          ),
          source,
        );
      const text = await exclusive(source, async () => {
        const scope: Record<string, ResolvedDataEntry> = Object.assign(
          Object.create(null) as Record<string, ResolvedDataEntry>,
          bindings,
        );
        delete scope[EXTRACT_KEY];
        const step = sentenceStep(
          `remember ${description.trim()} as {{${EXTRACT_KEY}}}`,
          source,
        );
        await runStep(
          {
            ...step,
            op: "remember",
            classificationSource: "pattern",
            probability: null,
          },
          scope,
          { group: [...groups], display: `extract ${description.trim()}` },
        );
        return scope[EXTRACT_KEY]!.value.reveal();
      });
      return parser ? parser.parse(text) : text;
    }) as Ai["extract"];

    const raw = activePage.playwright?.();
    const unavailable = () => {
      throw new Error(
        "The Playwright page is not available with this browser driver.",
      );
    };
    const env = Object.freeze({ ...dependencies.env });
    const attemptOrdinal = report?.test.currentAttempt?.ordinal ?? 1;
    const testContext: TestContext = {
      get page() {
        return raw?.page ?? unavailable();
      },
      get context() {
        return raw?.context ?? unavailable();
      },
      ai,
      env,
      testInfo: Object.freeze({
        id: test.identity,
        title: test.title,
        file: absolute,
        tags: [...test.tags],
        attempt: attemptOrdinal,
      }),
    };

    let thrown: unknown;
    let threw = false;
    try {
      await test.body(testContext);
    } catch (error) {
      thrown = error;
      threw = true;
    }
    if (inFlight) {
      await (inFlight as Promise<unknown>).catch(() => undefined);
      firstProblem ??= {
        status: "could_not_run",
        file: absolute,
        code: "invalid_test",
        source: test.source,
        message: "The test body finished while an ai step was still running.",
        fix: "Add `await` before each ai(...) call.",
      };
    }
    finished = true;

    let primary: Problem | null = firstProblem;
    if (!primary && threw && !isStepStop(thrown)) {
      if (
        thrown instanceof BrowserDriverError ||
        thrown instanceof ProviderError
      )
        primary = runtimeFailure(absolute, thrown) as Problem;
      else {
        const source =
          thrown instanceof Error ? where(thrown.stack) : test.source;
        const thrownIn =
          typeof thrown === "object" && thrown !== null && THROWN_IN in thrown
            ? (thrown as { [THROWN_IN]: readonly string[] })[THROWN_IN]
            : [];
        await recordCodeFailure(
          activePage,
          dependencies,
          source,
          thrown,
          thrownIn,
        );
        primary = { status: "failed", file: absolute, source };
      }
    }
    if (!primary) {
      await report?.test.finishTest("passed");
      return { status: "passed", file: absolute };
    }
    if (primary.status === "failed") await report?.test.finishTest("failed");
    return primary;
  } catch (error) {
    if (isStepStop(error)) return error.problem;
    return runtimeFailure(absolute, error);
  } finally {
    finished = true;
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(session);
  }
}

/** An exception from the test's own code is one failed step at its line. */
async function recordCodeFailure(
  page: BrowserPage,
  dependencies: AttemptDependencies,
  source: FlowSource,
  error: unknown,
  group: readonly string[],
): Promise<void> {
  const report = dependencies.report;
  if (!report) return;
  const attempt = report.test.currentAttempt;
  if (!attempt) return;
  const privacy = report.privacy;
  const index = attempt.stepCount + 1;
  const id = `${attempt.id}:step:${index}`;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The test body threw a non-Error value.";
  // Playwright's expect() errors carry a matcher result.
  const expectation =
    error instanceof Error && "matcherResult" in error
      ? "expect_failed"
      : "code_error";
  const firstLine = message.split("\n").find((line) => line.trim()) ?? message;
  let evidence: ResultStep["evidence"] = {
    status: "omitted",
    reason: "disabled",
  };
  if (report.evidenceEnabled && page.captureFrame && !page.closed)
    try {
      evidence = await report.saveFrame(
        attempt,
        `${id}:evidence`,
        await page.captureFrame(),
      );
    } catch {
      evidence = { status: "unavailable", reason: "capture_failed" };
    }
  await report.test.addStep({
    id,
    index,
    kind: "verify",
    operation: "code",
    phase: "steps",
    sentence: safeText(firstLine.trim(), privacy, 512),
    detail: safeText(
      error instanceof Error ? `${error.name} thrown by the test code.` : "",
      privacy,
      512,
    ),
    ...(group.length
      ? { group: group.map((name) => safeText(name, privacy, 120)) }
      : {}),
    sourceStack: [safeSource(source, dependencies.repoRoot, privacy)],
    state: "completed",
    verdict: "failed",
    flags: [],
    elapsedMs: 0,
    page: { status: "omitted", reason: "code_step" },
    locator: null,
    judgement: null,
    observations: [],
    calls: [],
    error: { code: expectation, message: safeText(message, privacy, 512) },
    evidence,
    replayFrame: null,
    targetBox: null,
  });
}
