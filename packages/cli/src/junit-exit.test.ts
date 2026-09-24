import { renderJunit } from "@sedum-dev/reporters";
import { describe, expect, it } from "vitest";
import { runExitCode } from "./exit-policy.js";
import { fixtures, unexecutedTest } from "../../reporters/src/test-fixtures.js";

/** The run testcase's single status element, if the document has one. */
function runStatus(xml: string): string | null {
  const suite = /<testsuite name="sedum run"[\s\S]*?<\/testsuite>/u.exec(
    xml,
  )![0];
  return (
    /<(failure|error) type="([^"]*)"/u.exec(suite)?.slice(1).join(":") ?? null
  );
}

describe("JUnit and the exit code (SED-13)", () => {
  const cases = {
    clean: fixtures.clean,
    flagged: () => fixtures.flagged("both"),
    failed: fixtures.failedVerify,
    failedAndFlagged: fixtures.failedAndFlagged,
    mixed: fixtures.mixed,
    operationalError: fixtures.operationalError,
    flaggedThenTimeout: fixtures.flaggedThenTimeout,
    noTests: fixtures.noTests,
    discovery: fixtures.discovery,
    unexecuted: unexecutedTest,
  };
  for (const [name, build] of Object.entries(cases))
    it(`${name}: the run testcase says what runExitCode says`, async () => {
      const result = await build();
      for (const strict of [false, true]) {
        const xml = renderJunit(result, { strict, evidenceDirectory: null });
        const exit = runExitCode(result, strict);
        const status = runStatus(xml);
        if (exit === 3) expect(status).toMatch(/^error:/u);
        else if (exit === 2) expect(status).toBe("failure:sedum.flagged");
        else expect(status).toBeNull();
        const statusElements = xml.match(/<(failure|error) /gu) ?? [];
        if (exit === 0) expect(statusElements).toEqual([]);
        if (exit === 1)
          expect(xml).toMatch(/<failure type="(?!sedum\.flagged)/u);
      }
    });
});
