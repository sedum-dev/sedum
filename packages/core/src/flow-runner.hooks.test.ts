import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import * as locatorModule from "./locator.js";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";

async function runHooks(
  source: string,
  options: {
    readonly module?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly judgements?: readonly number[];
    readonly root?: string;
    readonly prepared?: boolean;
    readonly runId?: string;
    readonly recorder?: RunRecorder;
    readonly finalize?: boolean;
    readonly readText?: string;
    readonly pageText?: string;
  } = {},
) {
  const root =
    options.root ?? (await mkdtemp(path.join(tmpdir(), "sedum-hooks-")));
  try {
    const file = path.join(root, "main.test.yaml");
    if (!options.prepared) {
      await writeFile(file, source);
      if (options.module)
        await writeFile(path.join(root, "shared.module.yaml"), options.module);
    }
    const version = {
      document: "doc-1",
      route: "https://example.test/",
      revision: 1,
    };
    const candidate = {
      ref: "price-ref",
      tag: "span",
      role: "",
      name: options.readText ?? "",
      peers: [],
      editable: false,
      disabled: false,
      inputType: "",
      signals: { path: "html/body/main/span:0" },
    };
    const candidatePage = {
      protocol: 1,
      version,
      total: 1,
      offset: 0,
      next: null,
      complete: true,
      candidates: [candidate],
    };
    const page = {
      url: version.route,
      closed: false,
      title: vi.fn(async () => "Example"),
      text: vi.fn(async () => options.pageText ?? "Example page text"),
      settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
      goto: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (expression: string) => {
        const value = expression.includes('bridge["quiet"]')
          ? { quiet: true, version }
          : expression.includes('bridge["collect"]') ||
              expression.includes('bridge["findBySignals"]')
            ? options.readText
              ? candidatePage
              : {
                  ...candidatePage,
                  total: 0,
                  candidates: [],
                }
            : expression.includes('bridge["readTarget"]')
              ? { status: "ok", text: options.readText }
              : expression.includes('bridge["digest"]')
                ? {
                    protocol: 1,
                    version,
                    text: options.readText
                      ? `Example page ${options.readText}`
                      : "Example page",
                    complete: true,
                  }
                : version;
        return { installed: true, protocol: 1, value };
      }),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const session = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    const launch = vi.fn(async () => session);
    const recorder =
      options.recorder ??
      new RunRecorder(async () => {}, options.runId ?? "hooks-run");
    if (!options.recorder) await recorder.start();
    let index = 0;
    const holds = vi.fn(async (_claim: string) => {
      void _claim;
      const probability = options.judgements?.[index++] ?? 0.95;
      return {
        holds: probability,
        contradicted: 1 - probability,
        call: {
          requestedModel: "test-model",
          model: "test-model",
          attempts: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          rate: null,
          successfulResponseCostUsd: null,
          totalCostUsd: null,
        },
      };
    });
    const choose = vi.fn(async () => ({
      selection: { kind: "candidate" as const, id: candidate.ref },
      probabilities: { [candidate.ref]: 0.9, none: 0.1 },
      confidence: null,
      call: {
        requestedModel: "test-model",
        model: "test-model",
        attempts: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        rate: null,
        successfulResponseCostUsd: null,
        totalCostUsd: null,
      },
    }));
    const result = await runFlow(file, {
      repoRoot: root,
      browser: { launch } as never,
      provider: {
        classifyBatch: vi.fn(),
        choose,
        holds,
      },
      classificationCache: new NoopClassificationCache(),
      env: options.env ?? {},
      baseUrl: version.route,
      report: {
        recorder,
        privacy: { secretValues: [] },
        evidenceEnabled: false,
        replay: false,
        saveFrame: vi.fn(),
      },
    });
    if (options.finalize !== false) {
      if (result.status === "could_not_run")
        await recorder.finish({
          code: "execution_error",
          message: "The run could not complete.",
        });
      else await recorder.finish();
    }
    return {
      result,
      report: recorder.snapshot,
      recorder,
      launch,
      holds,
      choose,
      page,
      context,
      session,
    };
  } finally {
    if (!options.root) await rm(root, { recursive: true, force: true });
  }
}

describe("hook and module attempt lifecycle", () => {
  it("executes setup, body and teardown in phase order", async () => {
    const run = await runHooks(
      "before: [verify setup]\nsteps: [verify body]\nafter: [verify cleanup]\n",
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("passed");
    expect(
      run.report.tests[0]?.attempts[0]?.steps.map((step) => step.phase),
    ).toEqual(["before", "steps", "after"]);
    expect(run.report.tests[0]?.attempts[0]?.problems).toEqual([]);
    expect(run.holds).toHaveBeenCalledTimes(3);
  });

  it("skips body after failed setup and keeps later cleanup problems secondary", async () => {
    const run = await runHooks(
      "before: [verify setup]\nsteps: [verify body]\nafter: [verify cleanup one, verify cleanup two]\n",
      { judgements: [0.05, 0.05, 0.95] },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("failed");
    const attempt = run.report.tests[0]?.attempts[0];
    expect(attempt?.steps.map((step) => [step.phase, step.verdict])).toEqual([
      ["before", "failed"],
      ["after", "failed"],
      ["after", "passed"],
    ]);
    expect(attempt?.problems.map((problem) => problem.phase)).toEqual([
      "before",
      "after",
    ]);
    expect(attempt?.primaryProblemId).toBe(attempt?.problems[0]?.id);
    expect(run.report.verdict).toBe("failed");
  });

  it("fails an otherwise passing attempt when teardown fails", async () => {
    const run = await runHooks(
      "steps: [verify body]\nafter: [verify cleanup]\n",
      { judgements: [0.95, 0.05] },
    );
    expect(run.result.status).toBe("failed");
    const attempt = run.report.tests[0]?.attempts[0];
    expect(attempt?.problems).toMatchObject([
      { phase: "after", outcome: "failed", origin: "step" },
    ]);
    expect(attempt?.primaryProblemId).toBe(attempt?.problems[0]?.id);
  });

  it("keeps a failed body primary when a later module environment binding errors", async () => {
    const run = await runHooks(
      "steps: [verify body]\nafter:\n  - use: ./shared.module.yaml\n    with: {password: $ABSENT}\n  - verify final cleanup\n",
      {
        module: "parameters: [password]\nsteps: [verify module cleanup]\n",
        judgements: [0.05, 0.95],
      },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("failed");
    const attempt = run.report.tests[0]?.attempts[0];
    expect(
      attempt?.problems.map((problem) => [problem.origin, problem.outcome]),
    ).toEqual([
      ["step", "failed"],
      ["module_binding", "error"],
    ]);
    expect(attempt?.steps.map((step) => step.phase)).toEqual([
      "steps",
      "after",
    ]);
    expect(attempt?.verdict).toBe("failed");
    expect(run.holds).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed body primary when a teardown locator retry throws", async () => {
    const resolve = vi
      .spyOn(locatorModule, "resolveTarget")
      .mockResolvedValueOnce({
        kind: "unresolved",
        reason: "stale",
        calls: [],
        diagnostic: {
          candidateCount: 0,
          rounds: 0,
          topOptions: [],
        },
      })
      .mockRejectedValueOnce(new Error("private locator failure"));
    try {
      const run = await runHooks(
        "steps: [verify body]\nafter: [click cleanup button]\n",
        { judgements: [0.05] },
      );
      expect(run.result.status, JSON.stringify(run.result)).toBe("failed");
      expect(
        run.report.tests[0]?.attempts[0]?.problems.map(
          (problem) => problem.outcome,
        ),
      ).toEqual(["failed", "error"]);
      expect(run.report.tests[0]?.attempts[0]?.verdict).toBe("failed");
      expect(JSON.stringify(run.report)).not.toContain(
        "private locator failure",
      );
    } finally {
      resolve.mockRestore();
    }
  });

  it("makes an unset setup credential operational and still runs teardown", async () => {
    const run = await runHooks(
      "before:\n  - use: ./shared.module.yaml\n    with: {password: $ABSENT}\nsteps: [verify body]\nafter: [verify cleanup]\n",
      { module: "parameters: [password]\nsteps: [verify inside module]\n" },
    );
    expect(run.result).toMatchObject({
      status: "could_not_run",
      code: "missing_environment_variable",
    });
    expect(run.report.state).toBe("error");
    expect(run.report.verdict).toBeNull();
    expect(run.report.tests[0]?.attempts[0]?.problems[0]).toMatchObject({
      origin: "module_binding",
      outcome: "error",
      phase: "before",
      stepId: null,
    });
    expect(
      run.report.tests[0]?.attempts[0]?.steps.map((step) => step.phase),
    ).toEqual(["after"]);
  });

  it("treats a skipped remembered binding as a secondary failure and continues teardown", async () => {
    const run = await runHooks(
      "steps:\n  - verify body\n  - remember the page text as {{later}}\nafter:\n  - use: ./shared.module.yaml\n    with: {text: '{{later}}'}\n  - verify final cleanup\n",
      {
        module: "parameters: [text]\nsteps: [verify module cleanup]\n",
        judgements: [0.05, 0.95],
      },
    );
    expect(run.result.status).toBe("failed");
    const attempt = run.report.tests[0]?.attempts[0];
    expect(attempt?.steps.map((step) => step.operation)).toEqual([
      "verify",
      "verify",
    ]);
    expect(
      attempt?.problems.map((problem) => [problem.origin, problem.outcome]),
    ).toEqual([
      ["step", "failed"],
      ["module_binding", "failed"],
    ]);
    expect(attempt?.problems[1]?.stepId).toBeNull();
  });

  it("continues teardown after a direct type step needs a skipped remembered value", async () => {
    const run = await runHooks(
      "steps:\n  - verify body\n  - remember the page text as {{later}}\nafter:\n  - type {{later}} into the note field\n  - verify final cleanup\n",
      { judgements: [0.05, 0.95] },
    );
    expect(run.result.status).toBe("failed");
    expect(
      run.report.tests[0]?.attempts[0]?.steps.map((step) => [
        step.phase,
        step.operation,
      ]),
    ).toEqual([
      ["steps", "verify"],
      ["after", "type"],
      ["after", "verify"],
    ]);
    expect(run.report.tests[0]?.attempts[0]?.problems[1]).toMatchObject({
      error: { code: "missing_remembered_binding" },
      outcome: "failed",
    });
  });

  it("binds a value remembered earlier in the same attempt when the later module is reached", async () => {
    const run = await runHooks(
      "steps:\n  - remember the page text as {{page_text}}\nafter:\n  - use: ./shared.module.yaml\n    with: {text: '{{page_text}}'}\n",
      { module: "parameters: [text]\nsteps: [verify cleanup completed]\n" },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("passed");
    const attempt = run.report.tests[0]?.attempts[0];
    expect(attempt?.steps.map((step) => step.operation)).toEqual([
      "remember",
      "verify",
    ]);
    expect(attempt?.steps[1]?.sourceStack).toMatchObject([
      { file: "main.test.yaml", line: 4 },
      { file: "shared.module.yaml", line: 2 },
    ]);
  });

  it("reads target-specific text and uses it in a later module assertion", async () => {
    const run = await runHooks(
      "steps:\n  - remember the price as {{price}}\nafter:\n  - use: ./shared.module.yaml\n    with: {text: '{{price}}'}\n",
      {
        readText: "$42",
        module:
          "parameters: [text]\nsteps:\n  - verify the price is {{text}}\n",
      },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("passed");
    expect(run.holds.mock.calls[0]?.[0]).toBe("the price is $42");
    expect(JSON.stringify(run.report)).not.toContain("$42");
  });

  it("keeps an environment-derived module argument out of Judge claims", async () => {
    const run = await runHooks(
      "steps:\n  - use: ./shared.module.yaml\n    with: {text: $SECRET}\n",
      {
        env: { SECRET: "private-value-123" },
        module: "parameters: [text]\nsteps:\n  - verify the code is {{text}}\n",
      },
    );
    expect(run.result.status).toBe("passed");
    expect(run.holds.mock.calls[0]?.[0]).toBe("the code is {{text}}");
    expect(JSON.stringify(run.report)).not.toContain("private-value-123");
  });

  it("does not launder an echoed environment credential through remember", async () => {
    const run = await runHooks(
      "data: {password: $SECRET}\nsteps:\n  - remember the password text as {{seen}}\nafter:\n  - use: ./shared.module.yaml\n    with: {text: '{{seen}}'}\n",
      {
        env: { SECRET: "private-value-123" },
        readText: "private-value-123",
        module:
          "parameters: [text]\nsteps:\n  - verify the password is {{text}}\n",
      },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("passed");
    expect(run.holds.mock.calls[0]?.[0]).toBe("the password is {{text}}");
    expect(JSON.stringify(run.choose.mock.calls)).not.toContain(
      "private-value-123",
    );
    expect(JSON.stringify(run.holds.mock.calls)).not.toContain(
      "private-value-123",
    );
    expect(JSON.stringify(run.report)).not.toContain("private-value-123");
  });

  it("redacts a remembered claim when a later module reveals its environment alias", async () => {
    const run = await runHooks(
      "steps:\n  - remember the page text as {{seen}}\n  - use: ./shared.module.yaml\n    with: {token: $SECRET}\n  - verify the page says {{seen}}\n",
      {
        env: { SECRET: "private-value-123" },
        pageText: "private-value-123",
        module: "parameters: [token]\nsteps:\n  - verify setup completed\n",
      },
    );
    expect(run.result.status, JSON.stringify(run.result)).toBe("passed");
    expect(run.holds.mock.calls[1]?.[0]).toBe("the page says [sensitive]");
    expect(JSON.stringify(run.holds.mock.calls)).not.toContain(
      "private-value-123",
    );
    expect(JSON.stringify(run.report)).not.toContain("private-value-123");
  });

  it("isolates concurrent invocations of one flow and module", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-concurrent-hooks-"));
    const source =
      "before:\n  - use: ./shared.module.yaml\n    with: {token: $TOKEN}\nsteps: [verify body]\n";
    try {
      await writeFile(path.join(root, "main.test.yaml"), source);
      await writeFile(
        path.join(root, "shared.module.yaml"),
        "parameters: [token]\nsteps: [verify setup]\n",
      );
      const [first, second] = await Promise.all([
        runHooks(source, {
          root,
          prepared: true,
          env: { TOKEN: "secret-one" },
          runId: "first-run",
        }),
        runHooks(source, {
          root,
          prepared: true,
          env: { TOKEN: "secret-two" },
          runId: "second-run",
        }),
      ]);
      expect(first.result.status).toBe("passed");
      expect(second.result.status).toBe("passed");
      expect(first.report.runId).not.toBe(second.report.runId);
      expect(first.report.tests[0]?.attempts[0]?.steps).toHaveLength(2);
      expect(second.report.tests[0]?.attempts[0]?.steps).toHaveLength(2);
      expect(JSON.stringify(first.report)).not.toContain("secret-one");
      expect(JSON.stringify(second.report)).not.toContain("secret-two");
      expect(first.context).not.toBe(second.context);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the module anew in a fresh context for a whole-test retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-retry-hooks-"));
    const source =
      "before:\n  - use: ./shared.module.yaml\n    with: {token: $TOKEN}\nsteps: [verify body]\n";
    try {
      await writeFile(path.join(root, "main.test.yaml"), source);
      await writeFile(
        path.join(root, "shared.module.yaml"),
        "parameters: [token]\nsteps: [verify setup]\n",
      );
      const recorder = new RunRecorder(async () => {}, "retry-run");
      await recorder.start();
      const first = await runHooks(source, {
        root,
        prepared: true,
        env: { TOKEN: "first-secret" },
        judgements: [0.05],
        recorder,
        finalize: false,
      });
      expect(first.result.status).toBe("failed");
      await recorder.startAttempt();
      const second = await runHooks(source, {
        root,
        prepared: true,
        env: { TOKEN: "second-secret" },
        recorder,
        finalize: false,
      });
      expect(second.result.status).toBe("passed");
      await recorder.finish();
      const attempts = recorder.snapshot.tests[0]?.attempts;
      expect(attempts?.map((attempt) => attempt.verdict)).toEqual([
        "failed",
        "passed",
      ]);
      expect(attempts?.map((attempt) => attempt.steps.length)).toEqual([1, 2]);
      expect(first.context).not.toBe(second.context);
      expect(JSON.stringify(recorder.snapshot)).not.toMatch(
        /first-secret|second-secret/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
