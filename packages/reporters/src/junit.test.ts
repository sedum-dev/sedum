import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resultTotals, type RunResult } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import { validateXML } from "xmllint-wasm";
import { neutralizeMarkers, renderJunit } from "./junit.js";
import { fixtures, unexecutedTest } from "./test-fixtures.js";

const fixtureDirectory = new URL("../test-fixtures/", import.meta.url);
const schema = await readFile(
  new URL("junit-10.xsd", fixtureDirectory),
  "utf8",
);
const EVIDENCE = ".sedum/runs/golden";

async function expectSchemaValid(xml: string): Promise<void> {
  const validation = await validateXML({
    xml: [{ fileName: "junit.xml", contents: xml }],
    schema: [{ fileName: "junit-10.xsd", contents: schema }],
  });
  expect(validation.errors.map((error) => error.message)).toEqual([]);
  expect(validation.valid).toBe(true);
}

interface ParsedCase {
  readonly suite: string;
  readonly classname: string;
  readonly name: string;
  readonly children: readonly {
    element: string;
    type?: string;
    message?: string;
    body: string;
  }[];
  readonly systemOut: string;
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1];
}

function unescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#9;/g, "\t")
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&amp;/g, "&");
}

/** Our own output only: one level of suites, flat testcases. */
function parse(xml: string) {
  const suites = [
    ...xml.matchAll(/<testsuite(\s[^>]*)>([\s\S]*?)<\/testsuite>/gu),
  ].map(([, tag, inner]) => {
    const cases: ParsedCase[] = [
      ...inner!.matchAll(
        /<testcase(\s[^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu,
      ),
    ].map(([, caseTag, body = ""]) => ({
      suite: unescape(attribute(tag!, "name")!),
      classname: unescape(attribute(caseTag!, "classname")!),
      name: unescape(attribute(caseTag!, "name")!),
      children: [
        ...body.matchAll(
          /<(failure|error|skipped)(\s[^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gu,
        ),
      ].map(([, element, childTag, childBody = ""]) => ({
        element: element!,
        ...(attribute(childTag!, "type") !== undefined
          ? { type: unescape(attribute(childTag!, "type")!) }
          : {}),
        ...(attribute(childTag!, "message") !== undefined
          ? { message: unescape(attribute(childTag!, "message")!) }
          : {}),
        body: unescape(childBody),
      })),
      systemOut: unescape(
        /<system-out>([\s\S]*?)<\/system-out>/u.exec(body)?.[1] ?? "",
      ),
    }));
    const count = (element: string) =>
      cases.filter((item) => item.children.some((c) => c.element === element))
        .length;
    return {
      name: unescape(attribute(tag!, "name")!),
      tag: tag!,
      properties: Object.fromEntries(
        [
          ...inner!.matchAll(/<property name="([^"]*)" value="([^"]*)"\/>/gu),
        ].map(([, name, value]) => [unescape(name!), unescape(value!)]),
      ),
      cases,
      counts: {
        tests: cases.length,
        failures: count("failure"),
        errors: count("error"),
        skipped: count("skipped"),
      },
    };
  });
  return { suites, cases: suites.flatMap((suite) => suite.cases) };
}

function testCase(xml: string, classname: string): ParsedCase {
  const found = parse(xml).cases.find((item) => item.classname === classname);
  expect(found, classname).toBeDefined();
  return found!;
}

function runCase(xml: string): ParsedCase | undefined {
  return parse(xml).cases.find((item) => item.suite === "sedum run");
}

/** Shape rules every rendered document must satisfy. */
async function expectWellFormed(result: RunResult, strict: boolean) {
  const xml = renderJunit(result, { strict, evidenceDirectory: EVIDENCE });
  await expectSchemaValid(xml);
  expect(renderJunit(result, { strict, evidenceDirectory: EVIDENCE })).toBe(
    xml,
  );
  const parsed = parse(xml);
  for (const item of parsed.cases)
    expect(item.children.length, item.name).toBeLessThanOrEqual(1);
  for (const suite of parsed.suites) {
    expect(Number(attribute(suite.tag, "tests"))).toBe(suite.counts.tests);
    expect(Number(attribute(suite.tag, "failures"))).toBe(
      suite.counts.failures,
    );
    expect(Number(attribute(suite.tag, "errors"))).toBe(suite.counts.errors);
    expect(Number(attribute(suite.tag, "skipped"))).toBe(suite.counts.skipped);
  }
  const root = /<testsuites(\s[^>]*)>/u.exec(xml)![1]!;
  expect(Number(attribute(root, "tests"))).toBe(parsed.cases.length);
  expect(
    Number(attribute(root, "failures")) + Number(attribute(root, "errors")),
  ).toBeLessThanOrEqual(parsed.cases.length);
  // The only `[[` in the document are the renderer's own attachment lines.
  const markers = xml.split("[[").length - 1;
  const attachments = xml.match(/\[\[ATTACHMENT\|\.sedum\/runs\/golden\//gu);
  expect(markers).toBe(attachments?.length ?? 0);
  return xml;
}

/** SED-13 exit mapping, restated from the RFC table. */
function expectedExit(result: RunResult, strict: boolean): 0 | 1 | 2 | 3 {
  if (
    result.state !== "completed" ||
    result.error !== null ||
    result.verdict === null ||
    result.totals.executedTests === 0
  )
    return 3;
  if (result.verdict === "failed") return 1;
  return strict && result.flags.length ? 2 : 0;
}

const allFixtures: Record<string, () => Promise<RunResult>> = {
  clean: fixtures.clean,
  low_confidence: () => fixtures.flagged("low_confidence"),
  contradiction: () => fixtures.flagged("contradiction"),
  both: () => fixtures.flagged("both"),
  failedVerify: fixtures.failedVerify,
  failedAction: fixtures.failedAction,
  mixed: fixtures.mixed,
  failedAndFlagged: fixtures.failedAndFlagged,
  retriedThenPassed: fixtures.retriedThenPassed,
  retriesExhausted: fixtures.retriesExhausted,
  operationalError: fixtures.operationalError,
  interrupted: fixtures.interrupted,
  flaggedThenTimeout: fixtures.flaggedThenTimeout,
  moduleBinding: fixtures.moduleBinding,
  noTests: fixtures.noTests,
  discovery: fixtures.discovery,
  frames: fixtures.frames,
  hostile: fixtures.hostile,
  unexecuted: unexecutedTest,
};

describe("JUnit reporter", () => {
  for (const [name, build] of Object.entries(allFixtures))
    it(`renders ${name} as schema-valid XML that agrees with the exit code`, async () => {
      const result = await build();
      for (const strict of [false, true]) {
        const xml = await expectWellFormed(result, strict);
        const exit = expectedExit(result, strict);
        const run = runCase(xml);
        const parsed = parse(xml);
        const failureTypes = parsed.cases.flatMap((item) =>
          item.children
            .filter((child) => child.element === "failure")
            .map((child) => child.type),
        );
        const errors = parsed.cases.flatMap((item) =>
          item.children.filter((child) => child.element === "error"),
        );
        if (exit === 0) {
          expect(failureTypes).toEqual([]);
          expect(errors).toEqual([]);
          expect(run).toBeUndefined();
        }
        if (exit === 1) {
          expect(run).toBeUndefined();
          expect(failureTypes.some((type) => type !== "sedum.flagged")).toBe(
            true,
          );
        }
        if (exit === 2) {
          expect(run?.children).toMatchObject([
            { element: "failure", type: "sedum.flagged" },
          ]);
          expect(failureTypes.every((type) => type === "sedum.flagged")).toBe(
            true,
          );
        }
        if (exit === 3)
          expect(run?.children).toMatchObject([{ element: "error" }]);
        // Every Sedum test is one suite, and the run totals are exact.
        const runSuite = parsed.suites.find(
          (suite) => suite.name === "sedum run",
        )!;
        expect(runSuite.properties).toMatchObject({
          "sedum.strict": String(strict),
          "sedum.flagged_steps": String(result.totals.flaggedSteps),
          "sedum.tests.passed": String(result.totals.passedTests),
          "sedum.tests.failed": String(result.totals.failedTests),
        });
        expect(
          Number(runSuite.properties["sedum.flags.low_confidence"]) +
            Number(runSuite.properties["sedum.flags.contradiction"]),
        ).toBeGreaterThanOrEqual(result.totals.flaggedSteps);
        expect(
          parsed.suites.filter(
            (suite) => suite.name !== "sedum run" && suite.name !== "discovery",
          ),
        ).toHaveLength(result.tests.length);
      }
    });

  it("keeps a clean run's test count equal to its Sedum tests", async () => {
    const xml = renderJunit(await fixtures.clean(), {
      strict: true,
      evidenceDirectory: EVIDENCE,
    });
    expect(xml).toContain(
      '<testsuites name="sedum" tests="1" failures="0" errors="0"',
    );
    expect(parse(xml).suites[0]).toMatchObject({
      name: "sedum run",
      cases: [],
    });
  });

  it("maps a flagged pass to metadata by default and a failure only with --strict", async () => {
    const result = await fixtures.flagged("both");
    const loose = testCase(
      renderJunit(result, { strict: false, evidenceDirectory: EVIDENCE }),
      "tests/cart.test.yaml",
    );
    expect(loose.children).toEqual([]);
    expect(loose.systemOut).toContain(
      "flags: low_confidence 1, contradiction 1 (flagged steps)",
    );
    expect(loose.systemOut).toContain(
      "passed, flagged — steps step 2 (verify): verify the cart shows 2 items",
    );
    // Scores keep the digits that put them on the right side of a line.
    expect(loose.systemOut).toContain(
      "holds 0.74 — fails below 0.60; passes at 0.75",
    );
    expect(loose.systemOut).toContain("contradiction 0.61 / cutoff 0.50");
    expect(loose.systemOut).toContain(
      `[[ATTACHMENT|${EVIDENCE}/evidence/a1-000000000000/000000000000000000000002.jpg]]`,
    );
    const strictXml = renderJunit(result, {
      strict: true,
      evidenceDirectory: EVIDENCE,
    });
    expect(testCase(strictXml, "tests/cart.test.yaml").children).toMatchObject([
      {
        element: "failure",
        type: "sedum.flagged",
        message: "passed with flags: low_confidence, contradiction (--strict)",
      },
    ]);
    const suite = parse(strictXml).suites.find(
      (item) => item.name === "tests/cart.test.yaml",
    )!;
    expect(suite.properties).toMatchObject({
      "sedum.verdict": "passed",
      "sedum.flags": "low_confidence,contradiction",
      "sedum.strict": "true",
    });
    expect(suite.tag).toContain('file="tests/cart.test.yaml"');
  });

  it("gives a failed test its primary problem, step context and rerun command", async () => {
    const xml = renderJunit(await fixtures.failedAction(), {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    const failed = testCase(xml, "tests/checkout.test.yaml");
    expect(failed.name).toBe("tests/checkout.test.yaml");
    expect(failed.children).toHaveLength(1);
    const [failure] = failed.children;
    expect(failure).toMatchObject({
      element: "failure",
      type: "ambiguous",
      message: "steps step 1 failed: click the Checkout button",
    });
    expect(failure!.body).toContain("where: tests/checkout.test.yaml:3:5");
    expect(failure!.body).toContain(
      "error: ambiguous: Could not choose the button.",
    );
    expect(failure!.body).toContain(
      "    waiting for getByRole('button', { name: 'Checkout' })",
    );
    expect(failure!.body).toContain(
      `frame: ${EVIDENCE}/evidence/a1-000000000000/000000000000000000000001.jpg`,
    );
    expect(failure!.body).toContain(
      "rerun: sedum run 'tests/checkout.test.yaml'",
    );
  });

  it("shows judged scores and page text for a failed claim", async () => {
    const xml = renderJunit(await fixtures.failedVerify(), {
      strict: false,
      evidenceDirectory: null,
    });
    const [failure] = testCase(xml, "tests/cart.test.yaml").children;
    expect(failure!.type).toBe("step_failed");
    expect(failure!.body).toContain(
      "holds 0.31 — fails below 0.60; passes at 0.75",
    );
    expect(failure!.body).toContain(
      "judged page text (untrusted):\n    Cart (2)\n    Subtotal $42.00",
    );
    // No evidence root: frames are named but never attached.
    expect(failure!.body).toContain(
      "frame: evidence/a1-000000000000/000000000000000000000002.jpg",
    );
    expect(xml).not.toContain("[[ATTACHMENT");
  });

  it("lists every attempt of a retried test", async () => {
    const passed = testCase(
      renderJunit(await fixtures.retriedThenPassed(), {
        strict: false,
        evidenceDirectory: EVIDENCE,
      }),
      "tests/checkout.test.yaml",
    );
    expect(passed.children).toEqual([]);
    expect(passed.systemOut).toBe("attempts: #1 failed (ambiguous), #2 passed");
    const exhausted = parse(
      renderJunit(await fixtures.retriesExhausted(), {
        strict: false,
        evidenceDirectory: EVIDENCE,
      }),
    );
    const failed = exhausted.cases.find(
      (item) => item.classname === "tests/checkout.test.yaml",
    )!;
    expect(failed.children[0]!.body).toContain(
      "attempts: #1 failed (ambiguous), #2 failed (ambiguous)",
    );
    const suite = exhausted.suites.find(
      (item) => item.name === "tests/checkout.test.yaml",
    )!;
    expect(suite.properties["sedum.attempts"]).toBe("2");
    expect(suite.tag).toContain('time="2.250"');
  });

  it("reports a run that could not finish as one error, even under --strict", async () => {
    const timeout = await fixtures.flaggedThenTimeout();
    const xml = renderJunit(timeout, {
      strict: true,
      evidenceDirectory: EVIDENCE,
    });
    expect(runCase(xml)).toMatchObject({
      children: [
        {
          element: "error",
          type: "run_timeout",
          message: "The run deadline expired.",
        },
      ],
    });
    expect(runCase(xml)!.children[0]!.body).toContain(
      "flags: low_confidence 1, contradiction 0 (flagged steps)",
    );
    // The flagged test keeps its own strict failure; the interrupted one errors.
    expect(testCase(xml, "tests/cart.test.yaml").children).toMatchObject([
      { element: "failure", type: "sedum.flagged" },
    ]);
    expect(testCase(xml, "tests/checkout.test.yaml").children).toMatchObject([
      { element: "error", type: "run_timeout" },
    ]);

    const interrupted = renderJunit(await fixtures.interrupted(), {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    expect(runCase(interrupted)!.children[0]).toMatchObject({
      element: "error",
      type: "canceled",
    });
    expect(runCase(interrupted)!.children[0]!.body).toContain(
      "2 of 3 selected tests did not start",
    );
    expect(
      testCase(interrupted, "tests/cart.test.yaml").children,
    ).toMatchObject([{ element: "error", type: "canceled" }]);
  });

  it("keeps a pre-run error, module binding and discovery problems visible", async () => {
    const empty = renderJunit(await fixtures.noTests(), {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    expect(runCase(empty)!.children).toMatchObject([
      {
        element: "error",
        type: "no_tests",
        message: "No tests were executed.",
      },
    ]);

    const binding = testCase(
      renderJunit(await fixtures.moduleBinding(), {
        strict: false,
        evidenceDirectory: EVIDENCE,
      }),
      "tests/login.test.yaml",
    );
    expect(binding.children[0]).toMatchObject({
      element: "error",
      type: "module_binding",
    });
    expect(binding.children[0]!.body).toContain(
      "module binding problem — before: module_binding: Module input 'password' is not set.",
    );
    expect(binding.children[0]!.body).toContain(
      "where: tests/login.test.yaml:3:5 → modules/ui-login.module.yaml:1:1",
    );

    const discovery = parse(
      renderJunit(await fixtures.discovery(), {
        strict: false,
        evidenceDirectory: EVIDENCE,
      }),
    );
    expect(
      discovery.cases.find((item) => item.suite === "discovery"),
    ).toMatchObject({
      classname: "tests/broken.test.yaml",
      name: "tests/broken.test.yaml:4:3 invalid_yaml",
      children: [
        {
          element: "error",
          type: "invalid_yaml",
          message: "Unexpected end of mapping.",
          body: "Fix: Close the mapping on line 4.",
        },
      ],
    });
  });

  it("names omitted and unavailable frames without attaching them", async () => {
    const xml = renderJunit(await fixtures.frames(), {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    const item = testCase(xml, "tests/cart.test.yaml");
    expect(item.children[0]!.body).toContain("frame: omitted (sensitive_page)");
    expect(item.children[0]!.body).toContain("frame: unavailable (frame_size)");
    expect(xml).not.toContain("[[ATTACHMENT");
  });

  it("marks a test that never ran as skipped, never an executed one", async () => {
    const xml = renderJunit(await unexecutedTest(), {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    expect(testCase(xml, "tests/never.test.yaml").children).toEqual([
      {
        element: "skipped",
        message: "not executed: run interrupted",
        body: "",
      },
    ]);
    expect(testCase(xml, "tests/login.test.yaml").children).toEqual([]);
  });

  it("cannot be steered by hostile result text", async () => {
    const result = await fixtures.hostile();
    const xml = renderJunit(result, {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("\u0007");
    expect(xml).not.toContain("[[[");
    expect(xml).toContain("\uFFFD lone surrogate");
    const file = "tests/[ [ATTACHMENT|x]].test.yaml";
    const hostile = parse(xml).cases.find((item) => item.classname === file)!;
    expect(hostile.name).toBe(
      "Title [ [ATTACHMENT|/etc/passwd]] <script>&amp; ]]> [ [ [ [",
    );
    expect(hostile.children[0]!.message).toBe(
      "steps step 1 failed: click [ [ [ATTACHMENT|/etc/passwd]] & <b>",
    );
    const attachments = xml.match(/\[\[ATTACHMENT\|[^\]]*\]\]/gu);
    expect(attachments).toEqual([
      `[[ATTACHMENT|${EVIDENCE}/evidence/a1-000000000000/000000000000000000000001.jpg]]`,
    ]);
  });

  it("renders measure steps, missing lines, unavailable pages and long text", async () => {
    const base = await fixtures.flagged("low_confidence");
    const test = base.tests[0]!;
    const attempt = test.attempts[0]!;
    const [first, flagged] = attempt.steps;
    const result = {
      ...base,
      tests: [
        {
          ...test,
          attempts: [
            {
              ...attempt,
              steps: [
                {
                  ...first!,
                  kind: "measure" as const,
                  verdict: null,
                  flags: ["contradiction" as const],
                },
                {
                  ...flagged!,
                  sentence: "",
                  page: { status: "unavailable" as const, reason: "closed" },
                  judgement: {
                    ...flagged!.judgement!,
                    threshold: null,
                    band: null,
                  },
                },
              ],
            },
          ],
        },
      ],
      discoveryProblems: [
        {
          file: "tests/unreadable.test.yaml",
          code: "unreadable",
          message: "Permission denied.",
          fix: "Check permissions.",
        },
      ],
      state: "error" as const,
      verdict: null,
      error: { code: "discovery_error", message: "1 problem." },
    };
    const both = ["contradiction", "low_confidence"] as RunResult["flags"];
    result.flags = both;
    result.tests[0]!.flags = both;
    result.tests[0]!.attempts[0]!.flags = both;
    result.totals = resultTotals(
      result.tests,
      result.setupCalls,
      result.selectedTestCount,
    );
    const xml = renderJunit(result, {
      strict: false,
      evidenceDirectory: EVIDENCE,
    });
    await expectSchemaValid(xml);
    const item = testCase(xml, "tests/cart.test.yaml");
    expect(item.systemOut).toContain(
      "holds 0.92 — observation, no decision line",
    );
    expect(item.systemOut).toContain("(no sentence recorded)");
    expect(item.systemOut).toContain("decision lines unavailable");
    expect(item.systemOut).toContain("page: unavailable (closed)");
    expect(parse(xml).cases.find((c) => c.suite === "discovery")!.name).toBe(
      "tests/unreadable.test.yaml unreadable",
    );

    // A failure message is one line of at most 512 code points.
    const failed = await fixtures.failedVerify();
    const sentence = "x".repeat(512);
    const withLong = {
      ...failed,
      tests: failed.tests.map((t) => ({
        ...t,
        attempts: t.attempts.map((a) => ({
          ...a,
          steps: a.steps.map((st) => ({ ...st, sentence })),
        })),
      })),
    };
    const [failure] = testCase(
      renderJunit(withLong, { strict: false, evidenceDirectory: null }),
      "tests/cart.test.yaml",
    ).children;
    expect([...failure!.message!]).toHaveLength(512);
    expect(failure!.message!.endsWith("x…")).toBe(true);
  });

  it("never leaves a `[[` in text it neutralizes", () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let run = 0; run < 2000; run++) {
      const length = next() % 12;
      const value = Array.from(
        { length },
        () => ["[", "[", "]", "A", "|"][next() % 5],
      ).join("");
      expect(neutralizeMarkers(value)).not.toContain("[[");
      expect(neutralizeMarkers(value).replace(/\[ /g, "[")).toBe(value);
    }
  });

  it("rejects an evidence directory that could escape or break an attachment", async () => {
    const result = await fixtures.clean();
    for (const evidenceDirectory of [
      "/abs/run",
      "C:/runs/x",
      "../outside",
      ".sedum/../../x",
      ".sedum//runs",
      "",
      ".sedum\\runs",
      ".sedum/[runs]",
      ".sedum/a|b",
    ])
      expect(
        () => renderJunit(result, { strict: false, evidenceDirectory }),
        evidenceDirectory,
      ).toThrow(/relative POSIX path/u);
  });

  it("matches the checked-in golden samples the CI summary job renders", async () => {
    const update = process.env.SEDUM_UPDATE_GOLDEN === "1";
    for (const name of ["mixed", "clean"] as const) {
      const jsonUrl = new URL(`golden/${name}.result.json`, fixtureDirectory);
      if (update)
        await writeFile(
          jsonUrl,
          `${JSON.stringify(await fixtures[name](), null, 2)}\n`,
        );
      const result = JSON.parse(await readFile(jsonUrl, "utf8")) as RunResult;
      expect(result).toEqual(await fixtures[name]());
      for (const strict of [false, true]) {
        const xmlUrl = new URL(
          `golden/${name}.${strict ? "strict" : "default"}.junit.xml`,
          fixtureDirectory,
        );
        const xml = renderJunit(result, {
          strict,
          evidenceDirectory: EVIDENCE,
        });
        if (update) await writeFile(xmlUrl, xml);
        expect(xml, fileURLToPath(xmlUrl)).toBe(await readFile(xmlUrl, "utf8"));
      }
    }
  });
});
