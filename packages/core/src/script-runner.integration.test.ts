import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import type { FlowRunResult } from "./flow-runner.js";
import type {
  JudgeDecision,
  JudgePageDigest,
  ProviderCall,
  ResolverCandidates,
  ResolverDecision,
} from "./provider.js";
import { RunRecorder } from "./run-recorder.js";
import type { RunResult } from "./run-result.js";
import { runScriptTest } from "./script-runner.js";

const scriptApi = pathToFileURL(
  fileURLToPath(new URL("./script-api.ts", import.meta.url)),
).href;

const call: ProviderCall = {
  requestedModel: "fake",
  model: "fake",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

/** Pick the candidate the sentence names, longest name first. */
function choose(
  sentence: string,
  offered: ResolverCandidates,
): Promise<ResolverDecision> {
  const candidates = offered.options.flatMap((option) =>
    option.kind === "candidate" ? [option.candidate] : [],
  );
  const wanted = sentence.toLowerCase();
  const picked = /cart total/u.test(wanted)
    ? candidates.find((candidate) => /cart total/iu.test(candidate.name))
    : [...candidates]
        .sort((a, b) => b.name.length - a.name.length)
        .find((candidate) => wanted.includes(candidate.name.toLowerCase()));
  const ids = [...candidates.map((candidate) => candidate.id), "none"];
  const selected = picked?.id ?? "none";
  return Promise.resolve({
    selection:
      selected === "none"
        ? { kind: "none" }
        : { kind: "candidate", id: selected },
    probabilities: Object.fromEntries(
      ids.map((id) => [id, id === selected ? 0.95 : 0.05 / (ids.length - 1)]),
    ),
    confidence: null,
    call,
  });
}

/** A claim `the page shows X` holds when the page text contains X. */
function holds(claim: string, digest: JudgePageDigest): Promise<JudgeDecision> {
  const fragment = /shows\s+(.+)$/u.exec(claim)?.[1] ?? claim;
  const found = digest.text.includes(fragment);
  return Promise.resolve({
    holds: found ? 0.97 : 0.03,
    contradicted: found ? 0.01 : 0.9,
    call,
  });
}

const PAGES: Record<string, string> = {
  "/login": `<!doctype html><title>Login</title><main>
    <label>Username <input id="user"></label>
    <label>Password <input id="password" type="password"></label>
    <button onclick="if (document.getElementById('password').value === 'pw-123') location.href='/home?user=' + encodeURIComponent(document.getElementById('user').value); else document.getElementById('error').textContent = 'Wrong password'">Login</button>
    <p id="error"></p></main>`,
  "/home": `<!doctype html><title>Home</title><main>
    <h1 id="welcome"></h1>
    <ul>
      <li>Camera $120.00 <button onclick="add(120)">Add Camera</button></li>
      <li>Phone $50.00 <button id="add-phone" onclick="add(50)">Add Phone</button></li>
    </ul>
    <p>Cart total <output id="total" aria-label="Cart total">$0.00</output></p>
    <script>
      const user = new URLSearchParams(location.search).get('user')
        ?? (document.cookie.includes('session=ada') ? 'Ada' : 'nobody');
      document.getElementById('welcome').textContent = 'Welcome ' + user;
      let total = 0;
      function add(price) {
        total += price;
        document.getElementById('total').textContent = '$' + total.toFixed(2);
      }
    </script></main>`,
};

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "TypeScript tests through the script runner",
  () => {
    let server: Server;
    let base = "";
    let root = "";

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-script-"));
      server = createServer((request, response) => {
        const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
        response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
        response.end(page ?? "missing");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture port missing");
      base = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    /** Files are imported once per process, so each source needs its own name. */
    async function run(
      name: string,
      source: string | undefined,
      identity?: string,
    ): Promise<{
      readonly outcome: FlowRunResult;
      readonly result: RunResult;
      readonly file: string;
      readonly provider: {
        choose: ReturnType<typeof vi.fn>;
        holds: ReturnType<typeof vi.fn>;
      };
    }> {
      const file = path.join(root, name);
      if (source !== undefined)
        await writeFile(
          file,
          `import { test, expect, secret } from ${JSON.stringify(scriptApi)};\n${source}`,
        );
      const recorder = new RunRecorder(async () => undefined, name);
      await recorder.start();
      const provider = {
        classifyBatch: vi.fn(),
        choose: vi.fn(choose),
        holds: vi.fn(holds),
      };
      const outcome = await runScriptTest(file, identity, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        provider,
        env: { SHOP_PASSWORD: "pw-123" },
        baseUrl: base,
        report: {
          recorder,
          privacy: { secretValues: [], sensitiveOrigins: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
        },
      });
      await recorder.finish(
        outcome.status === "could_not_run"
          ? { code: outcome.code, message: outcome.message }
          : null,
      );
      return { outcome, result: recorder.snapshot, file, provider };
    }

    it("mixes ai steps, Playwright code, groups, values, secrets, and extract", async () => {
      const { outcome, result, provider } = await run(
        "shop.test.ts",
        `
test("a customer fills the cart", { url: "/login", tags: ["cart"] }, async ({ page, ai, env, testInfo }) => {
  expect(testInfo.attempt).toBe(1);
  await ai.group("Log in", [
    "type {{user}} into the Username field",
    "type {{password}} into the Password field",
    "click the Login button",
  ], { user: "Ada", password: secret(env.SHOP_PASSWORD!) });
  await expect(page.locator("h1")).toHaveText("Welcome Ada");
  await ai("verify the page shows Welcome {{name}}", { name: "Ada" });
  await ai.group("Cart", async () => {
    await ai("click the {{button}} button", { button: "Add Camera" });
    await page.locator("#add-phone").click();
  });
  const total = await ai.extract("the cart total", {
    parse: (text: unknown) => Number(String(text).replace(/[^0-9.]/g, "")),
  });
  expect(total).toBe(170);
  await ai("remember the cart total as {{total}}");
  await ai("verify the page shows {{total}}");
});
`,
      );
      expect(outcome).toEqual({ status: "passed", file: expect.any(String) });
      const test = result.tests[0]!;
      expect(test.id).toBe("shop.test.ts#a customer fills the cart");
      expect(test.description).toBe("a customer fills the cart");
      expect(test.tags).toEqual(["cart"]);
      const steps = test.attempts[0]!.steps;
      expect(
        steps.map((step) => [step.operation, step.sentence, step.group ?? []]),
      ).toEqual([
        ["type", "type {{user}} into the Username field", ["Log in"]],
        ["type", "type {{password}} into the Password field", ["Log in"]],
        ["click", "click the Login button", ["Log in"]],
        ["verify", "verify the page shows Welcome Ada", []],
        ["click", "click the Add Camera button", ["Cart"]],
        ["remember", "extract the cart total", []],
        ["remember", "remember the cart total as {{total}}", []],
        ["verify", "verify the page shows {{total}}", []],
      ]);
      // Each step points at the line of its own ai(...) call.
      expect(steps.map((step) => step.sourceStack[0]!.line)).toEqual([
        5, 5, 5, 11, 13, 16, 20, 21,
      ]);
      expect(provider.holds).toHaveBeenLastCalledWith(
        "the page shows Cart total $170.00",
        expect.anything(),
        expect.anything(),
      );
      // The secret reached the page but never the model or the report.
      expect(JSON.stringify(result)).not.toContain("pw-123");
      for (const [sentence] of provider.choose.mock.calls)
        expect(sentence).not.toContain("pw-123");
    }, 60_000);

    it("stops the body at a failed step and records later code as never run", async () => {
      const { outcome, result } = await run(
        "stop.test.ts",
        `
let reached = false;
test("wrong claim", { url: "/home?user=Ada" }, async ({ ai }) => {
  await ai("verify the page shows Welcome Grace");
  reached = true;
});
test("reports reached", async () => {
  if (reached) throw new Error("the body kept running after a failed step");
});
`,
        "stop.test.ts#wrong claim",
      );
      expect(outcome).toMatchObject({
        status: "failed",
        source: { line: 5 },
      });
      const steps = result.tests[0]!.attempts[0]!.steps;
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        operation: "verify",
        verdict: "failed",
      });
      const second = await run(
        "stop.test.ts",
        undefined,
        "stop.test.ts#reports reached",
      );
      expect(second.outcome.status).toBe("passed");
    }, 60_000);

    it("reports a thrown expect() as a failed code step at its line and group", async () => {
      const { outcome, result } = await run(
        "expect.test.ts",
        `
test("badge", { url: "/home?user=Ada" }, async ({ page, ai }) => {
  await ai.group("Totals", async () => {
    await expect(page.locator("#total")).toHaveText("$999.00", { timeout: 300 });
  });
});
`,
      );
      expect(outcome).toMatchObject({ status: "failed", source: { line: 5 } });
      const step = result.tests[0]!.attempts[0]!.steps[0]!;
      expect(step).toMatchObject({
        operation: "code",
        verdict: "failed",
        group: ["Totals"],
        error: { code: "expect_failed" },
        sourceStack: [{ line: 5 }],
      });
      expect(result.tests[0]!.verdict).toBe("failed");
    }, 60_000);

    it("skips the login form by setting a cookie from code", async () => {
      const { outcome, result } = await run(
        "cookie.test.ts",
        `
test("session cookie", async ({ page, context, ai }) => {
  // Without a url the test starts at baseUrl, as a YAML test does.
  expect(page.url()).toBe(${JSON.stringify(`${base}/`)});
  await context.addCookies([{ name: "session", value: "ada", url: ${JSON.stringify(base)} }]);
  await page.goto(${JSON.stringify(`${base}/home`)});
  await ai("verify the page shows Welcome Ada");
});
`,
      );
      expect(outcome.status).toBe("passed");
      expect(result.tests[0]!.attempts[0]!.steps).toHaveLength(1);
    }, 60_000);

    it.each([
      [
        "missing value",
        `await ai("type {{user}} into the Username field");`,
        "{{user}} has no value.",
        4,
      ],
      [
        "missing await",
        `void ai("click the Login button");\n  await ai("click the Login button");`,
        "An ai step started while the previous one was still running.",
        5,
      ],
      [
        "invalid values",
        `await ai("type {{user}} into the Username field", { user: {} as never });`,
        "The value for {{user}} must be a string, a finite number, a boolean, or secret().",
        4,
      ],
      [
        "an unawaited failing step",
        `ai("type {{email}} into the Username field");\n  await new Promise((resolve) => setTimeout(resolve, 200));`,
        "{{email}} has no value.",
        4,
      ],
      [
        "groups nested too deep",
        `const nest = (n: number): Promise<unknown> => n === 0 ? ai("click the Login button") : ai.group("g" + n, () => nest(n - 1));\n  await nest(17);`,
        "Groups nest at most 16 deep.",
        4,
      ],
    ])(
      "reports %s as an invalid test at its line",
      async (name, body, message, line) => {
        const { outcome } = await run(
          `${name.replaceAll(" ", "-")}.test.ts`,
          `\ntest("usage", { url: "/login" }, async ({ ai }) => {\n  ${body}\n});\n`,
        );
        expect(outcome).toMatchObject({
          status: "could_not_run",
          code: "invalid_test",
          message,
          source: { line },
        });
      },
      60_000,
    );

    it("finishes the attempt when an unawaited step fails or starts after the body", async () => {
      const failing = await run(
        "unawaited-verify.test.ts",
        `
test("unawaited", { url: "/home?user=Ada" }, async ({ ai }) => {
  ai("verify the page shows Welcome Grace");
});
`,
      );
      // The failed claim is recorded and stays primary; the process survives.
      expect(failing.outcome).toMatchObject({
        status: "failed",
        source: { line: 4 },
      });
      expect(failing.result.tests[0]!.attempts[0]!.steps[0]).toMatchObject({
        operation: "verify",
        verdict: "failed",
      });
      const late = await run(
        "late.test.ts",
        `
test("late", { url: "/home?user=Ada" }, async ({ ai }) => {
  void ai.group("later", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ai("verify the page shows Welcome Ada");
  });
});
`,
      );
      expect(late.outcome).toMatchObject({
        status: "could_not_run",
        code: "invalid_test",
        message: "The test body finished while an ai step was still running.",
      });
    }, 60_000);

    it("answers ai.holds without failing the test", async () => {
      const { outcome, result } = await run(
        "holds.test.ts",
        `test("branches", { url: "/home" }, async ({ ai }) => {
          const shown = await ai.holds("the page shows Cart total");
          const missing = await ai.holds("the page shows Checkout complete");
          if (!shown || missing) throw new Error(\`unexpected \${shown} \${missing}\`);
        });`,
      );
      expect(outcome).toEqual({ status: "passed", file: expect.any(String) });
      const steps = result.tests[0]!.attempts[0]!.steps;
      expect(steps.map((step) => [step.sentence, step.verdict])).toEqual([
        ["verify the page shows Cart total", null],
        ["verify the page shows Checkout complete", null],
      ]);
    }, 60_000);

    it("describes a failed extract without exposing the internal remember step", async () => {
      const { outcome, result } = await run(
        "missing-extract.test.ts",
        `test("missing", { url: "/home" }, async ({ ai }) => {
          await ai.extract("the absent shipment number");
        });`,
      );
      expect(outcome.status).toBe("failed");
      expect(result.tests[0]?.attempts[0]?.steps[0]?.error?.message).toBe(
        "The extract target could not be resolved.",
      );
    });

    it.each([
      [
        "an unawaited group whose code throws",
        `void ai.group("totals", async () => {\n    throw new Error("expected 42 got 41");\n  });\n  await new Promise((resolve) => setTimeout(resolve, 100));`,
        "expected 42 got 41",
        5,
        ["totals"],
      ],
      [
        "an unawaited extract whose parser throws",
        `void ai.extract("the cart total", { parse: () => { throw new Error("not a number"); } });\n  await new Promise((resolve) => setTimeout(resolve, 1500));`,
        "not a number",
        4,
        [],
      ],
      [
        "an unawaited expect",
        `void expect(page.locator("h1")).toHaveText("Goodbye", { timeout: 200 });\n  await new Promise((resolve) => setTimeout(resolve, 600));`,
        "toHaveText",
        4,
        [],
      ],
      [
        "an unawaited click that fails when the page closes",
        `void page.locator("#never-there").click();`,
        "",
        4,
        [],
      ],
    ])(
      "fails the test for %s instead of passing or crashing",
      async (name, body, message, line, group) => {
        const { outcome, result } = await run(
          `${name.replaceAll(" ", "-")}.test.ts`,
          `\ntest("t", { url: "/home?user=Ada" }, async ({ page, ai }) => {\n  ${body}\n});\n`,
        );
        expect(outcome).toMatchObject({ status: "failed" });
        const step = result.tests[0]!.attempts[0]!.steps.find(
          (item) => item.operation === "code",
        )!;
        expect(step.error!.message).toContain(message);
        expect(step.group ?? []).toEqual(group);
        if (line) expect(step.sourceStack[0]!.line).toBe(line);
      },
      60_000,
    );

    it("lets a test handle a failing group on purpose", async () => {
      const { outcome } = await run(
        "handled.test.ts",
        `
test("optional banner", { url: "/home?user=Ada" }, async ({ ai }) => {
  await ai.group("optional", async () => {
    throw new Error("no banner today");
  }).catch(() => undefined);
  await ai("verify the page shows Welcome Ada");
});
`,
      );
      expect(outcome.status).toBe("passed");
    }, 60_000);

    it("selects one test by identity and reports an unknown one", async () => {
      await run(
        "many.test.ts",
        `
test("first", { url: "/home?user=A" }, async ({ ai }) => {
  await ai("verify the page shows Welcome A");
});
test("second", { id: "custom-second", url: "/home?user=B" }, async ({ ai }) => {
  await ai("verify the page shows Welcome B");
});
`,
        "many.test.ts#first",
      );
      const second = await run("many.test.ts", undefined, "custom-second");
      expect(second.outcome.status).toBe("passed");
      expect(second.result.tests[0]!.id).toBe("custom-second");
      const missing = await run("many.test.ts", undefined, "nope");
      expect(missing.outcome).toMatchObject({
        status: "could_not_run",
        code: "test_not_found",
      });
    }, 60_000);
  },
);
